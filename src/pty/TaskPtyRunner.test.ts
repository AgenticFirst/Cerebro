/**
 * Tests for TaskPtyRunner command construction and event emission.
 *
 * These tests verify:
 * 1. Claude Code args are constructed correctly
 * 2. Events are emitted properly (data, text, exit)
 * 3. ANSI stripping works for tag parsing
 * 4. Buffer flush interval works
 * 5. Exit code handling is correct
 *
 * Note: These tests mock node-pty and the claude binary detector since
 * we can't spawn real Claude Code processes in CI.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted ensures these are available when vi.mock factories run (hoisted above imports)
const { mockPtyProcess, mockSpawn } = vi.hoisted(() => {
  const proc = {
    pid: 12345,
    onData: vi.fn(),
    onExit: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  };
  return { mockPtyProcess: proc, mockSpawn: vi.fn(() => proc) };
});

vi.mock('node-pty', () => ({ spawn: mockSpawn }));

const { mockGetCachedClaudeCodeInfo } = vi.hoisted(() => ({
  mockGetCachedClaudeCodeInfo: vi.fn(() => ({
    status: 'available',
    path: '/usr/local/bin/claude',
    version: '2.1.0',
  })),
}));

vi.mock('../claude-code/detector', () => ({
  getCachedClaudeCodeInfo: mockGetCachedClaudeCodeInfo,
}));

vi.mock('../sandbox/wrap-spawn', () => ({
  wrapClaudeSpawn: vi.fn(({ claudeBinary, claudeArgs }: { claudeBinary: string; claudeArgs: string[] }) => ({
    binary: claudeBinary,
    args: claudeArgs,
    sandboxed: false,
  })),
}));

import { TaskPtyRunner, type TaskPtyRunOptions } from './TaskPtyRunner';

const DEFAULT_OPTIONS: TaskPtyRunOptions = {
  runId: 'test-run-id',
  prompt: 'Build a website',
  agentName: 'cerebro',
  cwd: '/tmp/workspace',
  maxTurns: 30,
  model: 'sonnet',
  appendSystemPrompt: 'Be helpful.',
};

describe('TaskPtyRunner — command construction', () => {
  let runner: TaskPtyRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCachedClaudeCodeInfo.mockReturnValue({
      status: 'available',
      path: '/usr/local/bin/claude',
      version: '2.1.0',
    });
    runner = new TaskPtyRunner();
  });

  it('passes correct args to claude binary', () => {
    runner.start(DEFAULT_OPTIONS);

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [binary, args] = mockSpawn.mock.calls[0];
    expect(binary).toBe('/usr/local/bin/claude');
    // Prompt is now positional (last arg) to get the full interactive TUI.
    expect(args).not.toContain('-p');
    expect(args[args.length - 1]).toBe('Build a website');
    expect(args).toContain('--session-id');
    expect(args).toContain('--agent');
    expect(args).toContain('cerebro');
    expect(args).toContain('--max-turns');
    expect(args).toContain('30');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('bypassPermissions');
    expect(args).toContain('--model');
    expect(args).toContain('sonnet');
    expect(args).toContain('--verbose');
  });

  it('includes --append-system-prompt when provided', () => {
    runner.start(DEFAULT_OPTIONS);

    const args = mockSpawn.mock.calls[0][1] as string[];
    const idx = args.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('Be helpful.');
  });

  it('omits --append-system-prompt when not provided', () => {
    runner.start({ ...DEFAULT_OPTIONS, appendSystemPrompt: undefined });

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).not.toContain('--append-system-prompt');
  });

  it('sets xterm-256color terminal type', () => {
    runner.start(DEFAULT_OPTIONS);

    const options = mockSpawn.mock.calls[0][2];
    expect(options.name).toBe('xterm-256color');
  });

  it('sets FORCE_COLOR=3 in environment', () => {
    runner.start(DEFAULT_OPTIONS);

    const options = mockSpawn.mock.calls[0][2];
    expect(options.env.FORCE_COLOR).toBe('3');
  });

  it('deletes CLAUDECODE from environment', () => {
    process.env.CLAUDECODE = '1';

    runner.start(DEFAULT_OPTIONS);

    const options = mockSpawn.mock.calls[0][2];
    expect(options.env.CLAUDECODE).toBeUndefined();

    delete process.env.CLAUDECODE;
  });

  it('uses provided CWD', () => {
    runner.start(DEFAULT_OPTIONS);

    const options = mockSpawn.mock.calls[0][2];
    expect(options.cwd).toBe('/tmp/workspace');
  });

  it('defaults maxTurns to 10 when not provided', () => {
    runner.start({ ...DEFAULT_OPTIONS, maxTurns: undefined });

    const args = mockSpawn.mock.calls[0][1] as string[];
    const idx = args.indexOf('--max-turns');
    expect(args[idx + 1]).toBe('10');
  });

  it('formats a 32-char hex runId into a dashed UUID for --session-id', () => {
    runner.start({ ...DEFAULT_OPTIONS, runId: 'e3a283b04fc342a8b48b45b73e2da528' });

    const args = mockSpawn.mock.calls[0][1] as string[];
    const idx = args.indexOf('--session-id');
    expect(args[idx + 1]).toBe('e3a283b0-4fc3-42a8-b48b-45b73e2da528');
  });

  it('formats a 32-char hex sessionId for --resume', () => {
    runner.start({
      ...DEFAULT_OPTIONS,
      resume: true,
      sessionId: 'e3a283b04fc342a8b48b45b73e2da528',
    });

    const args = mockSpawn.mock.calls[0][1] as string[];
    const idx = args.indexOf('--resume');
    expect(args[idx + 1]).toBe('e3a283b0-4fc3-42a8-b48b-45b73e2da528');
  });

  it('leaves an already-dashed UUID untouched', () => {
    runner.start({ ...DEFAULT_OPTIONS, runId: 'e3a283b0-4fc3-42a8-b48b-45b73e2da528' });

    const args = mockSpawn.mock.calls[0][1] as string[];
    const idx = args.indexOf('--session-id');
    expect(args[idx + 1]).toBe('e3a283b0-4fc3-42a8-b48b-45b73e2da528');
  });
});

describe('TaskPtyRunner — event emission', () => {
  let runner: TaskPtyRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetCachedClaudeCodeInfo.mockReturnValue({
      status: 'available',
      path: '/usr/local/bin/claude',
      version: '2.1.0',
    });
    runner = new TaskPtyRunner();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** After start(), grab the callbacks node-pty registered */
  function getCallbacks() {
    const dataCallback = mockPtyProcess.onData.mock.calls[0]?.[0] as ((data: string) => void) | undefined;
    const exitCallback = mockPtyProcess.onExit.mock.calls[0]?.[0] as ((info: { exitCode: number; signal?: number }) => void) | undefined;
    return { dataCallback: dataCallback!, exitCallback: exitCallback! };
  }

  it('emits data events with raw PTY output', () => {
    runner.start(DEFAULT_OPTIONS);
    const { dataCallback } = getCallbacks();
    const dataEvents: string[] = [];
    runner.on('data', (data: string) => dataEvents.push(data));

    dataCallback('Hello, world!');
    vi.advanceTimersByTime(16);

    expect(dataEvents).toHaveLength(1);
    expect(dataEvents[0]).toBe('Hello, world!');
  });

  it('emits text events with ANSI-stripped content', () => {
    runner.start(DEFAULT_OPTIONS);
    const { dataCallback } = getCallbacks();
    const textEvents: string[] = [];
    runner.on('text', (text: string) => textEvents.push(text));

    dataCallback('\x1b[32mHello\x1b[0m world');
    vi.advanceTimersByTime(16);

    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]).toBe('Hello world');
  });

  it('buffers multiple data chunks within 16ms', () => {
    runner.start(DEFAULT_OPTIONS);
    const { dataCallback } = getCallbacks();
    const dataEvents: string[] = [];
    runner.on('data', (data: string) => dataEvents.push(data));

    dataCallback('chunk1');
    dataCallback('chunk2');
    dataCallback('chunk3');
    vi.advanceTimersByTime(16);

    expect(dataEvents).toHaveLength(1);
    expect(dataEvents[0]).toBe('chunk1chunk2chunk3');
  });

  it('emits exit with correct code on normal completion', () => {
    runner.start(DEFAULT_OPTIONS);
    const { exitCallback } = getCallbacks();
    const exitEvents: Array<{ code: number; signal?: string }> = [];
    runner.on('exit', (code: number, signal?: string) => {
      exitEvents.push({ code, signal });
    });

    exitCallback({ exitCode: 0 });

    expect(exitEvents).toHaveLength(1);
    expect(exitEvents[0].code).toBe(0);
    expect(exitEvents[0].signal).toBeUndefined();
  });

  it('emits exit with code 1 for max-turns-reached', () => {
    runner.start(DEFAULT_OPTIONS);
    const { exitCallback } = getCallbacks();
    const exitEvents: Array<{ code: number; signal?: string }> = [];
    runner.on('exit', (code: number, signal?: string) => {
      exitEvents.push({ code, signal });
    });

    exitCallback({ exitCode: 1 });

    expect(exitEvents).toHaveLength(1);
    expect(exitEvents[0].code).toBe(1);
    expect(exitEvents[0].signal).toBeUndefined();
  });

  it('flushes remaining buffer on exit', () => {
    runner.start(DEFAULT_OPTIONS);
    const { dataCallback, exitCallback } = getCallbacks();
    const dataEvents: string[] = [];
    runner.on('data', (data: string) => dataEvents.push(data));

    dataCallback('final output');
    // Don't advance timers — exit immediately
    exitCallback({ exitCode: 0 });

    // Buffer should be flushed on exit
    expect(dataEvents).toHaveLength(1);
    expect(dataEvents[0]).toBe('final output');
  });

  it('still emits exit when abort() was called, and isAborted() is true', () => {
    runner.start(DEFAULT_OPTIONS);
    const { exitCallback } = getCallbacks();
    const exitEvents: Array<{ code: number }> = [];
    runner.on('exit', (code: number) => exitEvents.push({ code }));

    runner.abort();
    exitCallback({ exitCode: 0 });

    // Exit must fire so listeners (IPC handlers) get cleaned up. Callers
    // distinguish user-cancel from natural exit via isAborted().
    expect(exitEvents).toHaveLength(1);
    expect(runner.isAborted()).toBe(true);
  });

  it('accumulates text for getAccumulatedText()', () => {
    runner.start(DEFAULT_OPTIONS);
    const { dataCallback } = getCallbacks();

    dataCallback('Hello ');
    vi.advanceTimersByTime(16);
    dataCallback('World');
    vi.advanceTimersByTime(16);

    expect(runner.getAccumulatedText()).toBe('Hello World');
  });
});

describe('TaskPtyRunner — error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits exit(1) immediately when claude binary not detected', () => {
    mockGetCachedClaudeCodeInfo.mockReturnValueOnce({ status: 'unavailable' });

    const runner = new TaskPtyRunner();
    const exitEvents: number[] = [];
    runner.on('exit', (code: number) => exitEvents.push(code));

    runner.start(DEFAULT_OPTIONS);

    expect(exitEvents).toEqual([1]);
  });

  it('resize does not throw when process is null', () => {
    const runner = new TaskPtyRunner();
    expect(() => runner.resize(80, 24)).not.toThrow();
  });
});
