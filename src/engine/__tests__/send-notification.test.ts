import { describe, it, expect, vi } from 'vitest';
import { sendNotificationAction } from '../actions/send-notification';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext } from '../actions/types';

// Mock electron Notification
vi.mock('electron', () => ({
  Notification: Object.assign(
    class MockNotification {
      title: string;
      body: string;
      urgency: string;
      constructor(opts: { title: string; body: string; urgency?: string }) {
        this.title = opts.title;
        this.body = opts.body;
        this.urgency = opts.urgency ?? 'normal';
      }
      show() {}
    },
    {
      isSupported: () => true,
    },
  ),
}));

function makeContext(): ActionContext {
  return {
    runId: 'run-1',
    stepId: 'step-1',
    backendPort: 9999,
    signal: new AbortController().signal,
    log: vi.fn(),
    emitEvent: vi.fn(),
    resolveModel: vi.fn(),
  };
}

describe('sendNotificationAction', () => {
  it('shows a desktop notification', async () => {
    const result = await sendNotificationAction.execute({
      params: { title: 'Test Title', body: 'Test body' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    expect(result.data.sent).toBe(true);
    expect(result.summary).toContain('Test Title');
  });

  it('throws when title is missing', async () => {
    await expect(
      sendNotificationAction.execute({
        params: { title: '', body: 'body' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('requires a title');
  });
});
