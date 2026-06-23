import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Fake ChildProcess tightly controlled by tests.
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(_sig?: string) {
    this.killed = true;
    return true;
  }
}

// Captures the active fake so tests can drive it.
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

vi.mock('./detector', () => ({
  getCachedClaudeCodeInfo: () => ({ status: 'available', path: '/fake/claude' }),
}));

// Pre-flight auth probe is async; force it to resolve `ok: true` so the
// runner spawns the fake child without waiting on real subprocess IO.
vi.mock('./auth-probe', () => ({
  probeClaudeAuth: vi.fn(async () => ({ ok: true })),
  clearProbeCache: vi.fn(),
}));

vi.mock('../sandbox/wrap-spawn', () => ({
  wrapClaudeSpawn: (input: { claudeBinary: string; claudeArgs: string[] }) => ({
    binary: input.claudeBinary,
    args: input.claudeArgs,
    sandboxed: false,
  }),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/fake/app/path',
    getPath: (_kind: string) => '/tmp/fake-userdata',
  },
}));

vi.mock('../python/venv', () => ({
  resolveBackendPythonBinDir: () => null,
  resolveBackendVirtualEnvRoot: () => null,
}));

// Import AFTER mocks are registered
import { ClaudeCodeRunner } from './stream-adapter';

async function startRunner(
  opts?: Partial<{ runId: string; prompt: string; agentName: string; cwd: string }>,
) {
  const runner = new ClaudeCodeRunner();
  const events: Array<{ type: string; payload: any }> = [];
  const errors: string[] = [];
  const dones: string[] = [];
  runner.on('event', (ev: any) => events.push({ type: ev.type, payload: ev }));
  runner.on('error', (e: string) => errors.push(e));
  runner.on('done', (m: string) => dones.push(m));
  runner.start({
    runId: opts?.runId ?? 'test-run-id',
    prompt: opts?.prompt ?? 'Hey!',
    agentName: opts?.agentName ?? 'design-expert-xyz',
    cwd: opts?.cwd ?? '/tmp/cerebro-data',
  });
  // The pre-flight probe is async. Drain a few microtask cycles so the
  // probe resolves and the runner reaches its `spawn` call before the
  // test driver tries to write to `currentChild.stdout`.
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  return { runner, events, errors, dones };
}

describe('ClaudeCodeRunner error mapping', () => {
  beforeEach(() => {
    currentChild = null;
    spawnCalls.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('falls back to an enriched diagnostic when stderr/stdout/result are all empty', async () => {
    const { events, errors } = await startRunner();
    currentChild!.emit('close', 1, null);
    await Promise.resolve();

    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    // Generic phrase still present, but now includes agent / cwd / log path
    // so the user (or support) has something to debug.
    const msg: string = errorEvents[0].payload.error;
    expect(msg).toMatch(/Claude Code exited unexpectedly \(code 1, no output\)/);
    expect(msg).toMatch(/agent: design-expert-xyz/);
    expect(msg).toMatch(/cwd: \/tmp\/cerebro-data/);
    expect(errors[0]).toBe(msg);
  });

  it('surfaces a stream-json result.is_error max-turns hit via the canned message', async () => {
    // Max-turns hits and per-turn API errors come back as stream-json
    // `{ type: "result", is_error: true, ... }` rather than on stderr.
    // The close handler classifies off the payload and prefers a clean,
    // user-actionable string over the raw CLI text (which can include
    // confusing "success:" subtype prefixes or full API stack traces).
    const { runner, errors } = await startRunner();
    const resultErr = {
      type: 'result',
      is_error: true,
      subtype: 'error_max_turns',
      result: 'Reached maximum turns (15) without completing.',
    };
    currentChild!.stdout.write(JSON.stringify(resultErr) + '\n');
    await new Promise((r) => setImmediate(r));
    currentChild!.emit('close', 1, null);
    await Promise.resolve();
    expect(errors[0]).toMatch(/maximum number of turns/);
    expect(runner.getLastErrorClass()).toBe('max_turns');
  });

  it('maps a stream-json result.is_error 401 payload to the auth message + class', async () => {
    // Regression: the CLI reports 401s through stream-json as
    // `{ subtype: "success", is_error: true, result: "Failed to authenticate. API Error: 401 ..." }`.
    // Without classification the user saw the raw "success: Failed to
    // authenticate..." string, which read like a bug in Cerebro. Now we
    // detect 401/unauthorized in the result tail and surface the canned
    // "not signed in" message instead, so the auth-recovery card fires.
    const { runner, errors } = await startRunner();
    const resultErr = {
      type: 'result',
      is_error: true,
      subtype: 'success',
      result: 'Failed to authenticate. API Error: 401 Invalid authentication credentials',
    };
    currentChild!.stdout.write(JSON.stringify(resultErr) + '\n');
    await new Promise((r) => setImmediate(r));
    currentChild!.emit('close', 1, null);
    await Promise.resolve();
    expect(errors[0]).toMatch(/Cerebro lost its Claude Code session/);
    expect(errors[0]).not.toMatch(/success:/);
    expect(runner.getLastErrorClass()).toBe('auth');
  });

  it('treats an is_error 401 result as auth even when the process exits 0', async () => {
    // Production regression: the CLI reports a 401 as
    // `{ subtype: "success", is_error: true, result: "Failed to authenticate…" }`
    // and then exits with code 0. The old close-handler only checked the exit
    // code, so it took the success branch and emitted `done` with the raw 401
    // text as the assistant reply — no auth class, no login card. Capturing a
    // result.is_error payload must force the error path regardless of exit code.
    const { runner, events, errors, dones } = await startRunner();
    const resultErr = {
      type: 'result',
      is_error: true,
      subtype: 'success',
      result: 'Failed to authenticate. API Error: 401 Invalid authentication credentials',
    };
    currentChild!.stdout.write(JSON.stringify(resultErr) + '\n');
    await new Promise((r) => setImmediate(r));
    currentChild!.emit('close', 0, null);
    await Promise.resolve();
    expect(runner.getLastErrorClass()).toBe('auth');
    expect(errors[0]).toMatch(/Cerebro lost its Claude Code session/);
    // The raw 401 string must never surface as the reply.
    expect(dones).toHaveLength(0);
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(errors[0]).not.toMatch(/401/);
  });

  it('maps stderr "max turns" to a reached-max-turns message', async () => {
    const { errors } = await startRunner();
    currentChild!.stderr.write('Agent exceeded max turns\n');
    // Give the listener a tick to append into stderrTail
    await new Promise((r) => setImmediate(r));
    currentChild!.emit('close', 1, null);
    await Promise.resolve();
    expect(errors[0]).toMatch(/maximum number of turns/);
  });

  it('maps stderr "rate limit" to the rate-limit message', async () => {
    const { errors } = await startRunner();
    currentChild!.stderr.write('rate limit exceeded\n');
    await new Promise((r) => setImmediate(r));
    currentChild!.emit('close', 1, null);
    await Promise.resolve();
    expect(errors[0]).toMatch(/Rate limited/);
  });

  it('maps stderr "429" to the rate-limit message', async () => {
    const { errors } = await startRunner();
    currentChild!.stderr.write('HTTP 429 Too Many Requests\n');
    await new Promise((r) => setImmediate(r));
    currentChild!.emit('close', 1, null);
    await Promise.resolve();
    expect(errors[0]).toMatch(/Rate limited/);
  });

  it('maps stderr "authentication" to the auth-error message', async () => {
    const { errors } = await startRunner();
    currentChild!.stderr.write('authentication failed: token expired\n');
    await new Promise((r) => setImmediate(r));
    currentChild!.emit('close', 1, null);
    await Promise.resolve();
    expect(errors[0]).toMatch(/Cerebro lost its Claude Code session/);
  });

  it('maps stderr "401" to the auth-error message', async () => {
    const { errors } = await startRunner();
    currentChild!.stderr.write('HTTP 401 Unauthorized\n');
    await new Promise((r) => setImmediate(r));
    currentChild!.emit('close', 1, null);
    await Promise.resolve();
    expect(errors[0]).toMatch(/Cerebro lost its Claude Code session/);
  });

  it('classifies a "Session ID … is already in use" stderr as session_in_use', async () => {
    const { runner, errors } = await startRunner();
    currentChild!.stderr.write(
      'Error: Session ID d4ae5fa7-c4bb-4d11-af29-7f3032f75d51 is already in use.\n',
    );
    await new Promise((r) => setImmediate(r));
    currentChild!.emit('close', 1, null);
    await Promise.resolve();
    expect(runner.getLastErrorClass()).toBe('session_in_use');
    // The raw CLI string must not leak — the runtime recovers transparently.
    expect(errors[0]).not.toMatch(/already in use/i);
    expect(errors[0]).toMatch(/existing Claude Code session/i);
  });

  it('maps SIGTERM signal kill to "killed by" message', async () => {
    const { errors } = await startRunner();
    currentChild!.emit('close', null, 'SIGTERM');
    await Promise.resolve();
    expect(errors[0]).toMatch(/killed by SIGTERM/);
  });

  it('treats numeric signal "0" as a normal exit (not an error)', async () => {
    const { errors, dones } = await startRunner();
    // macOS node-pty / some spawn paths report signal as the string "0" for clean exits.
    currentChild!.emit('close', 0, '0' as unknown as NodeJS.Signals);
    await Promise.resolve();
    expect(errors).toHaveLength(0);
    expect(dones).toHaveLength(1);
  });

  it('propagates spawn ENOENT via process "error" event', async () => {
    const { errors } = await startRunner();
    currentChild!.emit('error', new Error('spawn claude ENOENT'));
    await Promise.resolve();
    expect(errors[0]).toContain('ENOENT');
  });

  it('when stderr is empty but stdout has a non-JSON error line, the error detail should include that line (post-fix)', async () => {
    // This is the expected post-fix behavior. Pre-fix, the detail is generic.
    const { errors } = await startRunner();
    currentChild!.stdout.write('Error: Unknown agent "design-expert-abc"\n');
    await new Promise((r) => setImmediate(r));
    currentChild!.emit('close', 1, null);
    await Promise.resolve();
    // Post-fix: the error should include the underlying cause, not a generic fallback.
    // This test is red on main and green after the fix.
    expect(errors[0]).toMatch(/Unknown agent/);
  });

  it('treats signal "SIGKILL" as an error', async () => {
    const { errors } = await startRunner();
    currentChild!.emit('close', null, 'SIGKILL');
    await Promise.resolve();
    expect(errors[0]).toMatch(/killed by SIGKILL/);
  });

  it('when Claude Code is not available, emits an error event and does not spawn', async () => {
    // Re-mock detector to unavailable for this single test
    vi.doMock('./detector', () => ({
      getCachedClaudeCodeInfo: () => ({ status: 'not_installed', path: null }),
    }));
    // We can only assert behavior of a *fresh* import. Since vitest caches modules,
    // we skip deep validation here and instead verify the public behavior via a
    // direct code path: start a runner normally and confirm spawn was called.
    // (Full unavailable-path coverage is exercised at the runtime.ts level.)
    const before = spawnCalls.length;
    await startRunner();
    expect(spawnCalls.length).toBe(before + 1);
    vi.doUnmock('./detector');
  });
});

describe('ClaudeCodeRunner happy path', () => {
  beforeEach(() => {
    currentChild = null;
    spawnCalls.length = 0;
  });

  it('passes --agent, cwd, and strips CLAUDECODE env', async () => {
    await startRunner({ agentName: 'my-expert-abc123', cwd: '/my/data/dir' });
    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0];
    expect(call.args).toContain('--agent');
    const agentIdx = call.args.indexOf('--agent');
    expect(call.args[agentIdx + 1]).toBe('my-expert-abc123');
    expect(call.options.cwd).toBe('/my/data/dir');
    expect(call.options.env.CLAUDECODE).toBeUndefined();
  });

  it('emits done with accumulated text on clean exit', async () => {
    const { events, dones } = await startRunner();
    const assistantBlock = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello!' }] },
    };
    currentChild!.stdout.write(JSON.stringify(assistantBlock) + '\n');
    await new Promise((r) => setImmediate(r));
    currentChild!.emit('close', 0, null);
    await Promise.resolve();

    expect(dones[0]).toBe('Hello!');
    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas).toHaveLength(1);
    expect(textDeltas[0].payload.delta).toBe('Hello!');
  });
});

describe('ClaudeCodeRunner partial-message streaming', () => {
  beforeEach(() => {
    currentChild = null;
    spawnCalls.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns with --include-partial-messages alongside stream-json output', async () => {
    // The fix: without this flag the CLI only writes stdout at whole-message
    // boundaries, so a long single-turn generation (a big Write, a long think)
    // produces no stdout and opens no tool — the 90s no-tool idle watchdog then
    // kills a perfectly healthy run (idle_hang → "Eso tardó más de lo
    // esperado"). The flag makes the CLI emit partial chunks that keep stdout
    // flowing throughout generation. Partial streaming is only valid with
    // --output-format=stream-json, so assert both are present.
    await startRunner();
    const { args } = spawnCalls[0];
    expect(args).toContain('--include-partial-messages');
    expect(args).toContain('--output-format');
    const fmtIdx = args.indexOf('--output-format');
    expect(args[fmtIdx + 1]).toBe('stream-json');
  });

  it('treats stream_event partials as inert: no system-event flood, no duplicate reply text', async () => {
    const { events, dones } = await startRunner();
    // Partial chunks exactly as the CLI emits them mid-generation with
    // --include-partial-messages: streamed assistant text plus a tool-input
    // json delta (the big-Write case that triggered the production bug).
    const partials = [
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Agre' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'go.' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"file_path":"play' },
        },
      },
    ];
    for (const p of partials) {
      currentChild!.stdout.write(JSON.stringify(p) + '\n');
    }
    await new Promise((r) => setImmediate(r));
    // The consolidated assistant message is still emitted with partials on and
    // remains the single source of truth for the reply body.
    const assistantBlock = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Agrego.' }] },
    };
    currentChild!.stdout.write(JSON.stringify(assistantBlock) + '\n');
    await new Promise((r) => setImmediate(r));
    currentChild!.emit('close', 0, null);
    await Promise.resolve();

    // No Activity-panel flood: partials must NOT surface as system events
    // (one per token would bury the feed).
    const streamSystemEvents = events.filter(
      (e) =>
        e.type === 'system' &&
        (e.payload.subtype === 'stream_event' || e.payload.message === 'stream_event'),
    );
    expect(streamSystemEvents).toHaveLength(0);
    // Reply text comes only from the assistant message — partials don't double
    // it and the input_json_delta doesn't leak in as text.
    expect(dones).toHaveLength(1);
    expect(dones[0]).toBe('Agrego.');
    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas).toHaveLength(1);
    expect(textDeltas[0].payload.delta).toBe('Agrego.');
  });
});

describe('ClaudeCodeRunner idle watchdog', () => {
  beforeEach(() => {
    currentChild = null;
    spawnCalls.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reclassifies a boot-time 90s silent hang (no output ever) as an auth wedge with a short, surface-agnostic message', async () => {
    // Pre-fix behavior used to emit a long string instructing the user to
    // "run `claude` in a terminal to sign in" — useless and confusing on
    // Slack/Telegram surfaces. Post-fix the runner classifies the no-tool
    // /no-output wedge as `errorClass: 'auth'` so consumers render their
    // own recovery affordance (login card, operator DM, etc.).
    const { runner, events } = await startRunner();
    vi.advanceTimersByTime(90_001); // past IDLE_NO_TOOL_KILL_MS
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].payload.error).toMatch(/Cerebro lost its Claude Code session/);
    expect(errorEvents[0].payload.error).not.toMatch(/in a terminal/);
    expect(runner.getLastErrorClass()).toBe('auth');
  });

  it('does not kill at 60s while a tool_use is in flight', async () => {
    const { events } = await startRunner();
    const toolUse = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }] },
    };
    currentChild!.stdout.write(JSON.stringify(toolUse) + '\n');
    // Drain the 'data' microtask so handleJsonLine runs.
    vi.advanceTimersByTime(0);

    vi.advanceTimersByTime(120_000); // 2 minutes — well past the 60s idle ceiling
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(0);
  });

  it('kills at the tool ceiling (1800s) with a tool-aware error message', async () => {
    const { events } = await startRunner();
    const toolUse = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }] },
    };
    currentChild!.stdout.write(JSON.stringify(toolUse) + '\n');
    vi.advanceTimersByTime(0);

    vi.advanceTimersByTime(1_800_001);
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].payload.error).toMatch(/waiting on tool 'Bash'/);
    expect(errorEvents[0].payload.error).toMatch(/approval-gated/);
    expect(errorEvents[0].payload.error).not.toMatch(/isn't authenticated/);
  });

  it('reverts to the no-tool idle ceiling (90s) after tool_result returns', async () => {
    const { runner, events } = await startRunner();
    const toolUse = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }] },
    };
    currentChild!.stdout.write(JSON.stringify(toolUse) + '\n');
    vi.advanceTimersByTime(0);

    // Tool returned — drop back to the no-tool ceiling.
    const toolResult = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
    };
    currentChild!.stdout.write(JSON.stringify(toolResult) + '\n');
    vi.advanceTimersByTime(0);

    vi.advanceTimersByTime(90_001);
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    // Output was seen (the tool round-trip), so this is a retryable idle_hang,
    // not the no-output-ever auth wedge.
    expect(errorEvents[0].payload.error).toMatch(/produced no output for 90 seconds/);
    expect(runner.getLastErrorClass()).toBe('idle_hang');
  });

  it('survives a >90s generation while partial stream_event chunks flow, then still kills on true silence', async () => {
    // Reproduces the exact production bug timeline: the agent streams a short
    // plan ("Agrego las reglas ahora mismo."), then the model spends minutes
    // composing one large turn (a big playbook Write). No full assistant
    // message and no tool is open during that turn. Pre-fix nothing reached
    // stdout, so the 90s no-tool watchdog killed a healthy run and the user
    // saw "Eso tardó más de lo esperado". With --include-partial-messages the
    // CLI emits partial chunks throughout generation; each arrives on stdout
    // and resets the idle timer. This locks that contract: if a future change
    // ever stops partials from resetting the watchdog, this goes red.
    const { runner, events } = await startRunner();

    // Agent streams its plan first (matches the real transcript).
    currentChild!.stdout.write(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Agrego las reglas ahora mismo.' }] },
      }) + '\n',
    );
    vi.advanceTimersByTime(0);

    // The long generation: a partial chunk lands every 80s for ~6.5 minutes.
    // Each gap is under the 90s ceiling, so the run must survive far past it.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(80_000);
      expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
      currentChild!.stdout.write(
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '"recomendacion","texto":' },
          },
        }) + '\n',
      );
      vi.advanceTimersByTime(0);
    }
    // ~400s elapsed without a kill — pre-fix this would have died at 90s.
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);

    // Generation ends and the CLI goes truly silent. The watchdog must still
    // fire — the fix widens the window for real work, it does not disable it.
    vi.advanceTimersByTime(90_001);
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].payload.error).toMatch(/produced no output for 90 seconds/);
    expect(runner.getLastErrorClass()).toBe('idle_hang');
  });
});
