import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendNotificationAction } from '../actions/send-notification';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext } from '../actions/types';

// ── Mock electron Notification ─────────────────────────────────
//
// `shownNotifications` is a shared array the mock pushes into on every
// `.show()` call. Tests assert on the most recent entry to verify what
// actually reached the OS layer.

interface ShownNotification {
  title: string;
  body: string;
  urgency: string;
}
const shownNotifications: ShownNotification[] = [];
let isSupported = true;

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
      show() {
        shownNotifications.push({
          title: this.title,
          body: this.body,
          urgency: this.urgency,
        });
      }
    },
    {
      isSupported: () => isSupported,
    },
  ),
}));

// ── Helpers ─────────────────────────────────────────────────────

function makeContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    runId: 'run-1',
    stepId: 'step-1',
    backendPort: 9999,
    signal: new AbortController().signal,
    log: vi.fn(),
    emitEvent: vi.fn(),
    resolveModel: vi.fn(),
    ...overrides,
  } as ActionContext;
}

function runNotify(
  params: Record<string, unknown>,
  wiredInputs: Record<string, unknown> = {},
  context: ActionContext = makeContext(),
) {
  return sendNotificationAction.execute({
    params,
    wiredInputs,
    scratchpad: new RunScratchpad(),
    context,
  });
}

beforeEach(() => {
  shownNotifications.length = 0;
  isSupported = true;
});

// ── Baseline ───────────────────────────────────────────────────

describe('sendNotificationAction: baseline', () => {
  it('shows a desktop notification and returns sent:true', async () => {
    const result = await runNotify({ title: 'Test Title', body: 'Test body' });
    expect(result.data.sent).toBe(true);
    expect(result.summary).toContain('Test Title');
    expect(shownNotifications.at(-1)).toEqual({
      title: 'Test Title',
      body: 'Test body',
      urgency: 'normal',
    });
  });

  it('returns the rendered title and body in data', async () => {
    const result = await runNotify({ title: 'Hi', body: 'there' });
    expect(result.data.title).toBe('Hi');
    expect(result.data.body).toBe('there');
  });

  it('forwards the urgency param to Electron', async () => {
    await runNotify({ title: 'Heads up', body: 'now', urgency: 'critical' });
    expect(shownNotifications.at(-1)?.urgency).toBe('critical');
  });

  it('defaults urgency to "normal" when not provided', async () => {
    await runNotify({ title: 'Heads up' });
    expect(shownNotifications.at(-1)?.urgency).toBe('normal');
  });
});

// ── Mustache templating ────────────────────────────────────────

describe('sendNotificationAction: variable templating', () => {
  it('renders {{variable}} in the title using wiredInputs', async () => {
    await runNotify(
      { title: 'Done: {{task_name}}', body: '' },
      { task_name: 'Refresh cache' },
    );
    expect(shownNotifications.at(-1)?.title).toBe('Done: Refresh cache');
  });

  it('renders {{variable}} in the body using wiredInputs', async () => {
    await runNotify(
      { title: 'Summary', body: 'Result:\n\n{{previous_output}}' },
      { previous_output: 'Two new items.' },
    );
    expect(shownNotifications.at(-1)?.body).toBe('Result:\n\nTwo new items.');
  });

  it('replaces missing variables with empty strings rather than crashing', async () => {
    const result = await runNotify(
      { title: 'Hello {{name}}', body: 'from {{sender}}' },
      { name: 'Alice' },
    );
    expect(result.data.sent).toBe(true);
    expect(shownNotifications.at(-1)?.title).toBe('Hello Alice');
    expect(shownNotifications.at(-1)?.body).toBe('from ');
  });

  it('does not HTML-escape angle brackets or ampersands (desktop banner is plain text)', async () => {
    await runNotify(
      { title: '<alert>', body: 'Bold & bright' },
      {},
    );
    expect(shownNotifications.at(-1)?.title).toBe('<alert>');
    expect(shownNotifications.at(-1)?.body).toBe('Bold & bright');
  });
});

// ── Guards ─────────────────────────────────────────────────────

describe('sendNotificationAction: input guards', () => {
  it('throws when title is missing entirely', async () => {
    await expect(runNotify({ title: '', body: 'body' })).rejects.toThrow(/title is empty/);
    expect(shownNotifications).toHaveLength(0);
  });

  it('throws when the rendered title is whitespace-only', async () => {
    await expect(runNotify({ title: '   ', body: 'body' })).rejects.toThrow(/title is empty/);
  });

  it('throws when {{variable}} renders to nothing and leaves title empty', async () => {
    await expect(
      runNotify({ title: '{{missing}}', body: 'body' }, {}),
    ).rejects.toThrow(/title is empty/);
  });

  it('does not throw when body is empty — body is optional', async () => {
    const result = await runNotify({ title: 'Just a heads up' });
    expect(result.data.sent).toBe(true);
    expect(shownNotifications.at(-1)?.body).toBe('');
  });
});

// ── Platform support ───────────────────────────────────────────

describe('sendNotificationAction: platform fallback', () => {
  it('returns sent:false (without throwing) when the OS does not support notifications', async () => {
    isSupported = false;
    const ctx = makeContext();
    const result = await runNotify({ title: 'No-op', body: 'nope' }, {}, ctx);
    expect(result.data.sent).toBe(false);
    expect(result.summary).toMatch(/not supported/i);
    expect(shownNotifications).toHaveLength(0);
    expect(ctx.log).toHaveBeenCalledWith(
      expect.stringMatching(/not supported/i),
    );
  });
});
