import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Fake ChildProcess tightly controlled by tests (mirrors the Claude
// stream-adapter test harness in src/claude-code/stream-adapter.test.ts).
class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(_sig?: string) {
    this.killed = true;
    return true;
  }
}

let currentChild: FakeChild | null = null;
const spawnCalls: Array<{ binary: string; args: string[]; options: any }> = [];

vi.mock('node:child_process', () => ({
  spawn: (binary: string, args: string[], options: any) => {
    const child = new FakeChild();
    currentChild = child;
    spawnCalls.push({ binary, args, options });
    return child;
  },
}));

vi.mock('../detector', () => ({
  getCachedCodexInfo: () => ({ status: 'available', path: '/fake/codex' }),
}));

vi.mock('../auth-probe', () => ({
  probeCodexAuth: vi.fn(async () => ({ ok: true })),
  clearCodexProbeCache: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/fake/app/path',
    getPath: (_kind: string) => '/tmp/fake-userdata',
  },
}));

vi.mock('../../../python/venv', () => ({
  resolveBackendPythonBinDir: () => null,
  resolveBackendVirtualEnvRoot: () => null,
}));

// Import AFTER mocks are registered
import { CodexRunner } from '../stream-adapter';

async function startRunner() {
  const runner = new CodexRunner();
  const events: Array<{ type: string; payload: any }> = [];
  const errors: string[] = [];
  const dones: string[] = [];
  runner.on('event', (ev: any) => events.push({ type: ev.type, payload: ev }));
  runner.on('error', (e: string) => errors.push(e));
  runner.on('done', (m: string) => dones.push(m));
  runner.start({
    runId: 'test-run-id',
    prompt: 'Hey!',
    agentName: 'cerebro',
    cwd: '/tmp/cerebro-data',
    sessionId: '',
  });
  // The pre-flight probe is async — drain microtasks until spawn happens.
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  return { runner, events, errors, dones };
}

const AGENT_TEXT = JSON.stringify({
  type: 'item.completed',
  item: { id: 'msg-1', type: 'agent_message', text: 'Working on it.' },
});
const TOOL_START = JSON.stringify({
  type: 'item.started',
  item: { id: 'tool-1', type: 'command_execution', command: 'ls' },
});
const TOOL_END = JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'tool-1',
    type: 'command_execution',
    command: 'ls',
    exit_code: 0,
    aggregated_output: 'ok',
  },
});

describe('CodexRunner idle watchdog', () => {
  beforeEach(() => {
    currentChild = null;
    spawnCalls.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('classifies a boot-time 90s silent hang (no output ever) as an auth wedge', async () => {
    const { runner, events } = await startRunner();
    vi.advanceTimersByTime(89_999); // just under IDLE_BOOT_WEDGE_KILL_MS
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    vi.advanceTimersByTime(2); // past the boundary
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].payload.error).toMatch(/Cerebro lost its Codex session/);
    expect(runner.getLastErrorClass()).toBe('auth');
  });

  it('never kills while a tool is in flight, no matter how long the silence', async () => {
    // Mirrors Claude Code semantics: approval-gated chat actions can block
    // for hours on a human. There is no tool-in-flight kill ceiling.
    const { events } = await startRunner();
    currentChild!.stdout.write(TOOL_START + '\n');
    vi.advanceTimersByTime(0);

    vi.advanceTimersByTime(6 * 60 * 60_000); // 6 hours of total silence
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
  });

  it('keeps emitting the agent_idle_warning heartbeat while a tool waits', async () => {
    // The Slack/Telegram bridges reap a run whose event stream goes silent
    // for RUN_IDLE_TIMEOUT_MS (5 min); the heartbeat keeps them fed.
    const { events } = await startRunner();
    currentChild!.stdout.write(TOOL_START + '\n');
    vi.advanceTimersByTime(0);

    vi.advanceTimersByTime(2 * 60 * 60_000); // 2 hours of silence, tool open
    const warnings = events.filter((e) => e.type === 'agent_idle_warning');
    expect(warnings.length).toBeGreaterThanOrEqual(55);
    // Widest allowed gap is the 2m→5m fixed-threshold stretch (3 minutes) —
    // always under the bridges' 5-minute reaper.
    const elapsed = warnings.map((w) => w.payload.elapsedMs as number);
    for (let i = 1; i < elapsed.length; i++) {
      expect(elapsed[i] - elapsed[i - 1]).toBeLessThanOrEqual(180_000);
    }
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
  });

  it('after output is seen, survives well past 90s and only fires the 30-minute backstop on true silence', async () => {
    const { runner, events } = await startRunner();
    currentChild!.stdout.write(TOOL_START + '\n');
    vi.advanceTimersByTime(0);
    currentChild!.stdout.write(TOOL_END + '\n');
    vi.advanceTimersByTime(0);

    // The old 90s no-tool kill must NOT fire — output was seen, so silence
    // here is normal (long generation ramp-up, upstream backpressure).
    vi.advanceTimersByTime(90_001);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);

    // 30 minutes of TOTAL silence = genuinely dead subprocess → retryable
    // idle_hang (never the no-output-ever auth wedge).
    vi.advanceTimersByTime(30 * 60_000);
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].payload.error).toMatch(/produced no output for 30 minutes/);
    expect(runner.getLastErrorClass()).toBe('idle_hang');
  });

  it('arms the mid-run backstop (not the 90s boot-wedge kill) from the very first output chunk', async () => {
    // Regression guard for the ordering bug: sawAnyOutput must flip BEFORE
    // resetIdleTimers() in the stdout handler, or the first chunk arms the
    // 90s boot-wedge timer and a stall right after thread.started still dies
    // at 90s despite the generous backstop.
    const { runner, events } = await startRunner();
    currentChild!.stdout.write(
      JSON.stringify({ type: 'thread.started', thread_id: 'th_1' }) + '\n',
    );
    vi.advanceTimersByTime(0);

    vi.advanceTimersByTime(10 * 60_000);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);

    vi.advanceTimersByTime(20 * 60_000 + 1);
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(runner.getLastErrorClass()).toBe('idle_hang');
  });

  it('heartbeat cadence during a no-tool silence never leaves a gap over 3 minutes', async () => {
    const { events } = await startRunner();
    currentChild!.stdout.write(AGENT_TEXT + '\n');
    vi.advanceTimersByTime(0);

    vi.advanceTimersByTime(29 * 60_000); // just under the 30-minute backstop
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    const warnings = events.filter((e) => e.type === 'agent_idle_warning');
    expect(warnings.length).toBeGreaterThanOrEqual(14);
    const elapsed = warnings.map((w) => w.payload.elapsedMs as number);
    for (let i = 1; i < elapsed.length; i++) {
      expect(elapsed[i] - elapsed[i - 1]).toBeLessThanOrEqual(180_000);
    }
  });

  it('stops the heartbeat once the process closes', async () => {
    const { events } = await startRunner();
    currentChild!.stdout.write(AGENT_TEXT + '\n');
    vi.advanceTimersByTime(0);
    currentChild!.emit('close', 0, null);
    await Promise.resolve();

    const before = events.filter((e) => e.type === 'agent_idle_warning').length;
    vi.advanceTimersByTime(60 * 60_000);
    const after = events.filter((e) => e.type === 'agent_idle_warning').length;
    expect(after).toBe(before);
  });
});
