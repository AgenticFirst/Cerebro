import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSendSlackMessageAction } from '../actions/send-slack-message';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext, ActionDefinition } from '../actions/types';
import type { SlackChannel } from '../actions/slack-channel';

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

interface ChannelStub extends SlackChannel {
  calls: Array<{ channel: string; text: string; threadTs?: string }>;
  allowed: Set<string>;
  reply: { messageTs: string | null; channelId: string | null; error: string | null };
  connected: boolean;
}

function makeChannel(overrides: Partial<ChannelStub> = {}): ChannelStub {
  const calls: ChannelStub['calls'] = [];
  const channel: ChannelStub = {
    calls,
    allowed: overrides.allowed ?? new Set(['C01ABCDE', 'D01XYZAB']),
    reply: overrides.reply ?? { messageTs: '1234.5678', channelId: 'C01ABCDE', error: null },
    connected: overrides.connected ?? true,
    isAllowlisted(channelId: string) { return this.allowed.has(channelId); },
    isConnected() { return this.connected; },
    async sendActionMessage(channelId, text, threadTs) {
      calls.push({ channel: channelId, text, threadTs });
      return this.reply;
    },
    async sendFileActionMessage() { return { fileId: null, error: null }; },
    async listChannels() { return { ok: true, channels: [] }; },
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
  action = createSendSlackMessageAction({ getChannel: () => channel });
});

describe('createSendSlackMessageAction', () => {
  it('sends a literal channel + text and returns sent:true', async () => {
    const result = await runAction(action, { channel: 'C01ABCDE', text: 'hello team' });
    expect(result.data).toEqual({
      sent: true,
      message_ts: '1234.5678',
      channel: 'C01ABCDE',
      error: null,
    });
    expect(channel.calls).toEqual([{ channel: 'C01ABCDE', text: 'hello team', threadTs: undefined }]);
  });

  it('forwards thread_ts to the channel', async () => {
    await runAction(action, { channel: 'C01ABCDE', text: 'reply', thread_ts: '999.000' });
    expect(channel.calls.at(-1)?.threadTs).toBe('999.000');
  });

  it('renders Mustache templates from wiredInputs (thread reply pattern)', async () => {
    await runAction(
      action,
      { channel: '{{__trigger__.channel}}', text: 'Got it', thread_ts: '{{__trigger__.thread_ts}}' },
      { '__trigger__': { channel: 'D01XYZAB', thread_ts: '111.222' } },
    );
    expect(channel.calls.at(-1)).toMatchObject({
      channel: 'D01XYZAB',
      text: 'Got it',
      threadTs: '111.222',
    });
  });

  it('throws when the bridge is not connected', async () => {
    const noChannelAction = createSendSlackMessageAction({ getChannel: () => null });
    await expect(runAction(noChannelAction, { channel: 'C01ABCDE', text: 'hi' }))
      .rejects.toThrow(/bridge is not enabled/i);
  });

  it('throws when channel renders empty', async () => {
    await expect(runAction(action, { channel: '', text: 'hi' }))
      .rejects.toThrow(/channel is empty/);
  });

  it('throws when text renders empty', async () => {
    await expect(runAction(action, { channel: 'C01ABCDE', text: '   ' }))
      .rejects.toThrow(/text is empty/);
  });

  it('throws when channel is not allowlisted', async () => {
    await expect(runAction(action, { channel: 'C999XYZ', text: 'hi' }))
      .rejects.toThrow(/not in the Slack allowlist/);
    expect(channel.calls).toHaveLength(0);
  });

  it('returns sent:false when the channel reports failure', async () => {
    channel.reply = { messageTs: null, channelId: null, error: 'channel_not_found' };
    const ctx = makeContext();
    const result = await runAction(action, { channel: 'C01ABCDE', text: 'hi' }, {}, ctx);
    expect(result.data).toEqual({
      sent: false,
      message_ts: null,
      channel: 'C01ABCDE',
      error: 'channel_not_found',
    });
    expect(result.summary).toMatch(/Slack send failed/);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringMatching(/Slack send failed for C01ABCDE/));
  });

  it('reports availability based on isConnected()', () => {
    expect(action.availabilityCheck?.()).toBe('available');
    channel.connected = false;
    expect(action.availabilityCheck?.()).toBe('not_connected');
    const noChan = createSendSlackMessageAction({ getChannel: () => null });
    expect(noChan.availabilityCheck?.()).toBe('not_connected');
  });
});
