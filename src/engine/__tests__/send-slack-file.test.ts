import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSendSlackFileAction } from '../actions/send-slack-file';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext, ActionDefinition } from '../actions/types';
import type { SlackChannel } from '../actions/slack-channel';

function makeContext(): ActionContext {
  return {
    runId: 'run-1',
    stepId: 'step-1',
    backendPort: 9999,
    signal: new AbortController().signal,
    log: vi.fn(),
    emitEvent: vi.fn(),
  } as ActionContext;
}

interface ChannelStub extends SlackChannel {
  calls: Array<{ channel: string; filePath: string; options?: Record<string, unknown> }>;
  reply: { fileId: string | null; error: string | null };
}

function makeChannel(): ChannelStub {
  const calls: ChannelStub['calls'] = [];
  return {
    calls,
    reply: { fileId: 'F123', error: null },
    isAllowlisted: () => true,
    isConnected: () => true,
    async sendActionMessage() { return { messageTs: null, channelId: null, error: null }; },
    async sendFileActionMessage(channel, filePath, options) {
      calls.push({ channel, filePath, options });
      return this.reply;
    },
    async listChannels() { return { ok: true, channels: [] }; },
  };
}

let channel: ChannelStub;
let action: ActionDefinition;

beforeEach(() => {
  channel = makeChannel();
  action = createSendSlackFileAction({ getChannel: () => channel });
});

describe('createSendSlackFileAction', () => {
  it('uploads with channel + file_path and surfaces the file id', async () => {
    const result = await action.execute({
      params: { channel: 'C01ABCDE', file_path: '/tmp/report.pdf', comment: 'See attached' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data).toEqual({
      sent: true,
      file_id: 'F123',
      channel: 'C01ABCDE',
      error: null,
    });
    expect(channel.calls[0].filePath).toBe('/tmp/report.pdf');
    expect(channel.calls[0].options).toMatchObject({ comment: 'See attached' });
  });

  it('throws when channel or file_path empty', async () => {
    await expect(action.execute({
      params: { channel: '', file_path: '/tmp/x' },
      wiredInputs: {}, scratchpad: new RunScratchpad(), context: makeContext(),
    })).rejects.toThrow(/channel is empty/);
    await expect(action.execute({
      params: { channel: 'C01ABCDE', file_path: '' },
      wiredInputs: {}, scratchpad: new RunScratchpad(), context: makeContext(),
    })).rejects.toThrow(/file_path is empty/);
  });

  it('returns sent:false when upload fails', async () => {
    channel.reply = { fileId: null, error: 'file_too_large' };
    const ctx = makeContext();
    const result = await action.execute({
      params: { channel: 'C01ABCDE', file_path: '/tmp/big.bin' },
      wiredInputs: {}, scratchpad: new RunScratchpad(), context: ctx,
    });
    expect(result.data).toMatchObject({ sent: false, error: 'file_too_large' });
    expect(ctx.log).toHaveBeenCalledWith(expect.stringMatching(/file upload failed/));
  });
});
