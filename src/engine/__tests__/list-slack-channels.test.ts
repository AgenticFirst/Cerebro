import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createListSlackChannelsAction } from '../actions/list-slack-channels';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext, ActionDefinition } from '../actions/types';
import type { SlackChannel } from '../actions/slack-channel';

function makeContext(): ActionContext {
  return {
    runId: 'r1', stepId: 's1', backendPort: 9999,
    signal: new AbortController().signal,
    log: vi.fn(), emitEvent: vi.fn(),
  } as ActionContext;
}

function makeChannel(result: { ok: boolean; channels?: Array<{ id: string; name: string; is_private: boolean }>; error?: string }): SlackChannel {
  return {
    isAllowlisted: () => true,
    isConnected: () => true,
    async sendActionMessage() { return { messageTs: null, channelId: null, error: null }; },
    async sendFileActionMessage() { return { fileId: null, error: null }; },
    async listChannels() { return result; },
  };
}

let action: ActionDefinition;

describe('createListSlackChannelsAction', () => {
  beforeEach(() => {
    action = createListSlackChannelsAction({
      getChannel: () => makeChannel({
        ok: true,
        channels: [
          { id: 'C1', name: 'general', is_private: false },
          { id: 'C2', name: 'random', is_private: false },
        ],
      }),
    });
  });

  it('returns the channel list', async () => {
    const result = await action.execute({
      params: {}, wiredInputs: {}, scratchpad: new RunScratchpad(), context: makeContext(),
    });
    expect(result.data.ok).toBe(true);
    expect((result.data.channels as Array<unknown>).length).toBe(2);
  });

  it('throws when bridge is not connected', async () => {
    const a = createListSlackChannelsAction({ getChannel: () => null });
    await expect(a.execute({
      params: {}, wiredInputs: {}, scratchpad: new RunScratchpad(), context: makeContext(),
    })).rejects.toThrow(/bridge is not enabled/);
  });

  it('returns ok:false when listing fails', async () => {
    const a = createListSlackChannelsAction({
      getChannel: () => makeChannel({ ok: false, error: 'invalid_auth' }),
    });
    const result = await a.execute({
      params: {}, wiredInputs: {}, scratchpad: new RunScratchpad(), context: makeContext(),
    });
    expect(result.data).toMatchObject({ ok: false, error: 'invalid_auth' });
  });
});
