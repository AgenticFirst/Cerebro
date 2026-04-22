import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSendTelegramAction } from '../actions/send-telegram-message';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext, ActionDefinition } from '../actions/types';
import type { TelegramChannel } from '../actions/telegram-channel';

function makeContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    runId: 'run-1',
    stepId: 'step-1',
    backendPort: 9999,
    signal: new AbortController().signal,
    log: vi.fn(),
    emitEvent: vi.fn(),
    ...overrides,
  } as ActionContext;
}

interface ChannelStub extends TelegramChannel {
  calls: Array<{ chatId: string; text: string; parseMode?: string }>;
  allowed: Set<string>;
  reply: { messageId: number | null; error: string | null };
}

function makeChannel(overrides: Partial<ChannelStub> = {}): ChannelStub {
  const calls: ChannelStub['calls'] = [];
  const channel: ChannelStub = {
    calls,
    allowed: overrides.allowed ?? new Set(['111', '222']),
    reply: overrides.reply ?? { messageId: 42, error: null },
    isAllowlisted(id: string) { return this.allowed.has(id); },
    async sendActionMessage(chatId, text, parseMode) {
      calls.push({ chatId, text, parseMode });
      return this.reply;
    },
  };
  return channel;
}

function runAction(
  action: ActionDefinition,
  params: Record<string, unknown>,
  wiredInputs: Record<string, unknown> = {},
  context: ActionContext = makeContext(),
) {
  return action.execute({
    params,
    wiredInputs,
    scratchpad: new RunScratchpad(),
    context,
  });
}

let channel: ChannelStub;
let action: ActionDefinition;

beforeEach(() => {
  channel = makeChannel();
  action = createSendTelegramAction({ getChannel: () => channel });
});

describe('createSendTelegramAction: baseline', () => {
  it('sends a literal chat_id + message and returns sent:true', async () => {
    const result = await runAction(action, { chat_id: '111', message: 'hello' });
    expect(result.data).toEqual({
      sent: true, message_id: 42, chat_id: '111', error: null,
    });
    expect(channel.calls).toEqual([{ chatId: '111', text: 'hello', parseMode: undefined }]);
  });

  it('forwards parse_mode to the channel', async () => {
    await runAction(action, { chat_id: '111', message: '*bold*', parse_mode: 'MarkdownV2' });
    expect(channel.calls.at(-1)?.parseMode).toBe('MarkdownV2');
  });

  it('renders Mustache templates against wiredInputs', async () => {
    await runAction(
      action,
      { chat_id: '{{chat_id}}', message: 'You said: {{message_text}}' },
      { chat_id: '222', message_text: 'standup' },
    );
    expect(channel.calls.at(-1)).toMatchObject({ chatId: '222', text: 'You said: standup' });
  });

  it('trims surrounding whitespace from the rendered chat_id', async () => {
    await runAction(action, { chat_id: '  111  ', message: 'hi' });
    expect(channel.calls.at(-1)?.chatId).toBe('111');
  });
});

describe('createSendTelegramAction: guards', () => {
  it('throws when the bridge is not connected', async () => {
    const noChannelAction = createSendTelegramAction({ getChannel: () => null });
    await expect(runAction(noChannelAction, { chat_id: '111', message: 'hi' }))
      .rejects.toThrow(/bridge is not enabled/i);
  });

  it('throws when chat_id renders empty', async () => {
    await expect(runAction(action, { chat_id: '', message: 'hi' }))
      .rejects.toThrow(/chat_id is empty/);
    await expect(runAction(action, { chat_id: '{{missing}}', message: 'hi' }, {}))
      .rejects.toThrow(/chat_id is empty/);
  });

  it('throws when message renders empty', async () => {
    await expect(runAction(action, { chat_id: '111', message: '   ' }))
      .rejects.toThrow(/message is empty/);
  });

  it('throws (clean) when chat_id is not allowlisted', async () => {
    await expect(runAction(action, { chat_id: '999', message: 'hi' }))
      .rejects.toThrow(/not in the Telegram allowlist/);
    expect(channel.calls).toHaveLength(0);
  });
});

describe('createSendTelegramAction: send failure', () => {
  it('returns sent:false with the error when the channel reports failure', async () => {
    channel.reply = { messageId: null, error: 'Forbidden: bot was blocked by the user' };
    const ctx = makeContext();
    const result = await runAction(action, { chat_id: '111', message: 'hi' }, {}, ctx);
    expect(result.data).toEqual({
      sent: false,
      message_id: null,
      chat_id: '111',
      error: 'Forbidden: bot was blocked by the user',
    });
    expect(result.summary).toMatch(/Telegram send failed/);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringMatching(/Telegram send failed for 111/));
  });
});
