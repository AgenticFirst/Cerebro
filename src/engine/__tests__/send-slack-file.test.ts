import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSendSlackFileAction } from '../actions/send-slack-file';
import { RunScratchpad } from '../scratchpad';
import { resolveMediaInput } from '../actions/utils/media-resolver';
import type { ActionContext, ActionDefinition } from '../actions/types';
import type { SlackChannel } from '../actions/slack-channel';

vi.mock('../actions/utils/media-resolver', () => ({
  resolveMediaInput: vi.fn(),
}));

const resolveMediaInputMock = resolveMediaInput as unknown as ReturnType<typeof vi.fn>;

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
  resolveMediaInputMock.mockReset();
  resolveMediaInputMock.mockResolvedValue({
    absPath: '/tmp/report.pdf',
    fileName: 'report.pdf',
    mime: null,
    sizeBytes: 1024,
  });
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
    expect(resolveMediaInputMock).toHaveBeenCalledWith(9999, undefined, '/tmp/report.pdf');
    // The resolved absolute path — not the raw input — reaches the bridge.
    expect(channel.calls[0].filePath).toBe('/tmp/report.pdf');
    expect(channel.calls[0].options).toMatchObject({ comment: 'See attached', fileName: 'report.pdf' });
  });

  it('de-annotates a `@/path` file_path via the resolver and uploads the real file', async () => {
    resolveMediaInputMock.mockResolvedValue({
      absPath: '/home/agents-ia/Desktop/cerebro-logo.png',
      fileName: 'cerebro-logo.png',
      mime: null,
      sizeBytes: 316_000,
    });
    const result = await action.execute({
      params: { channel: 'C01ABCDE', file_path: '@/home/agents-ia/Desktop/cerebro-logo.png' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(resolveMediaInputMock).toHaveBeenCalledWith(
      9999,
      undefined,
      '@/home/agents-ia/Desktop/cerebro-logo.png',
    );
    expect(channel.calls[0].filePath).toBe('/home/agents-ia/Desktop/cerebro-logo.png');
    expect(result.data).toMatchObject({ sent: true });
  });

  it('resolves a file_item_id through the resolver', async () => {
    resolveMediaInputMock.mockResolvedValue({
      absPath: '/var/cerebro/files/abc.pdf',
      fileName: 'manual.pdf',
      mime: 'application/pdf',
      sizeBytes: 2048,
    });
    await action.execute({
      params: { channel: 'C01ABCDE', file_item_id: 'item-123' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(resolveMediaInputMock).toHaveBeenCalledWith(9999, 'item-123', undefined);
    expect(channel.calls[0].filePath).toBe('/var/cerebro/files/abc.pdf');
    expect(channel.calls[0].options).toMatchObject({ fileName: 'manual.pdf' });
  });

  it('throws when channel is empty', async () => {
    await expect(action.execute({
      params: { channel: '', file_path: '/tmp/x' },
      wiredInputs: {}, scratchpad: new RunScratchpad(), context: makeContext(),
    })).rejects.toThrow(/channel is empty/);
  });

  it('rethrows resolver failures with a Send Slack File prefix', async () => {
    resolveMediaInputMock.mockRejectedValue(new Error('must provide either file_item_id or file_path'));
    await expect(action.execute({
      params: { channel: 'C01ABCDE' },
      wiredInputs: {}, scratchpad: new RunScratchpad(), context: makeContext(),
    })).rejects.toThrow(/Send Slack File: must provide either file_item_id or file_path/);
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
