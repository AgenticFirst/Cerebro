import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  channelAction,
  registerChannelSender,
  unregisterChannelSender,
} from '../actions/channel';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext, ActionInput } from '../actions/types';

function makeContext(): ActionContext {
  return {
    runId: 'run-1',
    stepId: 'step-1',
    backendPort: 9999,
    signal: new AbortController().signal,
    log: vi.fn(),
    emitEvent: vi.fn(),
  };
}

function makeInput(params: Record<string, unknown>): ActionInput {
  return {
    params,
    wiredInputs: {},
    scratchpad: new RunScratchpad(),
    context: makeContext(),
  };
}

afterEach(() => {
  unregisterChannelSender('telegram');
});

describe('channelAction', () => {
  it('reports skipped when no sender is registered', async () => {
    const out = await channelAction.execute(
      makeInput({ channel: 'telegram', operation: 'send', recipients: ['1'], message: 'hi' }),
    );
    expect(out.data.delivered).toBe(false);
    expect(out.data.skipped).toBe(1);
    expect((out.data.errors as string[]).join(' ')).toContain('not connected');
  });

  it('rejects unsupported operations', async () => {
    const out = await channelAction.execute(
      makeInput({ channel: 'telegram', operation: 'receive', recipients: ['1'], message: 'hi' }),
    );
    expect(out.data.delivered).toBe(false);
    expect((out.data.errors as string[]).join(' ')).toMatch(/not supported/);
  });

  it('rejects when no recipients are provided', async () => {
    const out = await channelAction.execute(
      makeInput({ channel: 'telegram', operation: 'send', recipients: [], message: 'hi' }),
    );
    expect(out.data.delivered).toBe(false);
    expect((out.data.errors as string[]).join(' ')).toMatch(/no recipients/);
  });

  it('dispatches to a registered sender and reports counts', async () => {
    const send = vi.fn().mockResolvedValue({ sent: 2, skipped: 1, errors: ['one failed'] });
    registerChannelSender('telegram', { sendProactive: send });

    const out = await channelAction.execute(
      makeInput({
        channel: 'telegram',
        operation: 'send',
        recipients: ['1', '2', '3'],
        message: 'routine completed',
      }),
    );

    expect(send).toHaveBeenCalledWith(['1', '2', '3'], 'routine completed');
    expect(out.data.sent).toBe(2);
    expect(out.data.skipped).toBe(1);
    expect(out.data.delivered).toBe(true);
  });
});
