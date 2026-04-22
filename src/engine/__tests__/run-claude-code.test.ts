import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext } from '../actions/types';

// Capture spawn/execFile calls and drive their fake child processes from
// within tests. `wrapClaudeSpawn` is also stubbed to return the args as-is
// so we can inspect what Claude Code would actually receive.
const spawnCalls: Array<{ binary: string; args: string[]; opts: unknown }> = [];
let nextChild: FakeChild | null = null;
let claudeAvailable = true;

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  killed = false;
  kill(signal?: string) {
    this.killed = true;
    // Real child_process emits 'close' asynchronously after kill; defer so
    // the abort-handler's reject runs before the close handler.
    setImmediate(() => {
      this.stdout.push(null);
      this.stderr.push(null);
      this.emit('close', signal === 'SIGTERM' ? 143 : 1);
    });
    return true;
  }
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn((binary: string, args: string[], opts: unknown) => {
    spawnCalls.push({ binary, args, opts });
    const child = nextChild ?? new FakeChild();
    nextChild = null;
    return child;
  }),
  execFile: vi.fn((_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
    cb(claudeAvailable ? null : new Error('not found'));
  }),
}));

vi.mock('../../sandbox/wrap-spawn', () => ({
  wrapClaudeSpawn: (opts: { claudeBinary: string; claudeArgs: string[] }) => ({
    binary: opts.claudeBinary,
    args: opts.claudeArgs,
  }),
}));

// Import the action *after* the mocks so they take effect.
const { runClaudeCodeAction } = await import('../actions/run-claude-code');

function makeContext(signal?: AbortSignal): ActionContext {
  return {
    runId: 'run-1',
    stepId: 'step-1',
    backendPort: 9999,
    signal: signal ?? new AbortController().signal,
    log: vi.fn(),
    emitEvent: vi.fn(),
    resolveModel: vi.fn(),
  };
}

function finishChild(child: FakeChild, opts: { stdout?: string; stderr?: string; code?: number }) {
  if (opts.stdout) child.stdout.push(Buffer.from(opts.stdout));
  if (opts.stderr) child.stderr.push(Buffer.from(opts.stderr));
  child.stdout.push(null);
  child.stderr.push(null);
  child.emit('close', opts.code ?? 0);
}

beforeEach(() => {
  spawnCalls.length = 0;
  nextChild = null;
  claudeAvailable = true;
});

describe('runClaudeCodeAction — happy paths', () => {
  it('returns response text, exit_code, duration, files_modified', async () => {
    const child = (nextChild = new FakeChild());
    const promise = runClaudeCodeAction.execute({
      params: { mode: 'ask', prompt: 'What is 2+2?' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    // Drive the fake child after the action has subscribed to its streams
    await new Promise((r) => setTimeout(r, 10));
    finishChild(child, {
      stdout: 'The answer is 4. Check src/math.ts for details.',
      code: 0,
    });

    const result = await promise;
    expect(result.data.exit_code).toBe(0);
    expect(result.data.response).toContain('answer is 4');
    expect(typeof result.data.duration_ms).toBe('number');
    expect(Array.isArray(result.data.files_modified)).toBe(true);
    expect((result.data.files_modified as string[]).some((p) => p.includes('math.ts'))).toBe(true);
  });

  it('uses mode=ask tool scope by default', async () => {
    const child = (nextChild = new FakeChild());
    const promise = runClaudeCodeAction.execute({
      params: { prompt: 'hello' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    await new Promise((r) => setTimeout(r, 10));
    finishChild(child, { stdout: 'hi', code: 0 });
    await promise;

    const allowedToolsIdx = spawnCalls[0].args.indexOf('--allowedTools');
    expect(allowedToolsIdx).toBeGreaterThan(-1);
    expect(spawnCalls[0].args[allowedToolsIdx + 1]).toBe('Read,Glob,Grep');
  });

  it('plan mode prepends planning prefix and restricts tools', async () => {
    const child = (nextChild = new FakeChild());
    const promise = runClaudeCodeAction.execute({
      params: { mode: 'plan', prompt: 'refactor auth' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    await new Promise((r) => setTimeout(r, 10));
    finishChild(child, { stdout: 'plan...', code: 0 });
    await promise;

    // Prompt is the last arg.
    const fullPrompt = spawnCalls[0].args[spawnCalls[0].args.length - 1];
    expect(fullPrompt).toMatch(/^Plan the implementation \(do NOT write code\):/);
    expect(fullPrompt).toContain('refactor auth');

    const allowedToolsIdx = spawnCalls[0].args.indexOf('--allowedTools');
    expect(spawnCalls[0].args[allowedToolsIdx + 1]).toContain('Bash(git diff)');
    // implement-only tools like Write must NOT be present
    expect(spawnCalls[0].args[allowedToolsIdx + 1]).not.toMatch(/Write/);
  });

  it('implement mode allows Write/Edit/Bash', async () => {
    const child = (nextChild = new FakeChild());
    const promise = runClaudeCodeAction.execute({
      params: { mode: 'implement', prompt: 'add a test' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    await new Promise((r) => setTimeout(r, 10));
    finishChild(child, { stdout: 'done', code: 0 });
    await promise;
    const allowedToolsIdx = spawnCalls[0].args.indexOf('--allowedTools');
    expect(spawnCalls[0].args[allowedToolsIdx + 1]).toBe('Read,Write,Edit,Glob,Grep,Bash');
  });

  it('review mode prepends review prefix', async () => {
    const child = (nextChild = new FakeChild());
    const promise = runClaudeCodeAction.execute({
      params: { mode: 'review', prompt: 'diff against main' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    await new Promise((r) => setTimeout(r, 10));
    finishChild(child, { stdout: 'LGTM', code: 0 });
    await promise;
    const fullPrompt = spawnCalls[0].args[spawnCalls[0].args.length - 1];
    expect(fullPrompt).toMatch(/^Review the following code changes:/);
  });

  it('templates {{vars}} in prompt and working_directory', async () => {
    const child = (nextChild = new FakeChild());
    const promise = runClaudeCodeAction.execute({
      params: {
        mode: 'ask',
        prompt: 'Look at {{file}}',
        working_directory: '/tmp/{{dir}}',
      },
      wiredInputs: { file: 'src/a.ts', dir: 'work' },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    await new Promise((r) => setTimeout(r, 10));
    finishChild(child, { stdout: 'ok', code: 0 });
    await promise;

    const fullPrompt = spawnCalls[0].args[spawnCalls[0].args.length - 1];
    expect(fullPrompt).toContain('src/a.ts');
    expect((spawnCalls[0].opts as { cwd?: string }).cwd).toBe('/tmp/work');
  });

  it('passes --max-turns when max_turns is set', async () => {
    const child = (nextChild = new FakeChild());
    const promise = runClaudeCodeAction.execute({
      params: { mode: 'ask', prompt: 'hi', max_turns: 3 },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    await new Promise((r) => setTimeout(r, 10));
    finishChild(child, { stdout: 'ok', code: 0 });
    await promise;

    const idx = spawnCalls[0].args.indexOf('--max-turns');
    expect(idx).toBeGreaterThan(-1);
    expect(spawnCalls[0].args[idx + 1]).toBe('3');
  });

  it('restricts env vars to SAFE_ENV_KEYS', async () => {
    process.env.NAUGHTY_LEAK = 'should-not-leak';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    try {
      const child = (nextChild = new FakeChild());
      const promise = runClaudeCodeAction.execute({
        params: { mode: 'ask', prompt: 'hi' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      });
      await new Promise((r) => setTimeout(r, 10));
      finishChild(child, { stdout: 'ok', code: 0 });
      await promise;

      const env = (spawnCalls[0].opts as { env: Record<string, string> }).env;
      expect(env.NAUGHTY_LEAK).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
    } finally {
      delete process.env.NAUGHTY_LEAK;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe('runClaudeCodeAction — failure paths', () => {
  it('rejects when prompt is empty', async () => {
    await expect(
      runClaudeCodeAction.execute({
        params: { mode: 'ask', prompt: '' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('requires a prompt');
  });

  it('rejects when prompt templates to empty', async () => {
    await expect(
      runClaudeCodeAction.execute({
        params: { mode: 'ask', prompt: '{{missing}}' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('requires a prompt');
  });

  it('rejects when claude CLI is not installed', async () => {
    claudeAvailable = false;
    await expect(
      runClaudeCodeAction.execute({
        params: { mode: 'ask', prompt: 'hi' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow(/Claude Code CLI not found/);
  });

  it('rejects on non-zero exit with no response', async () => {
    const child = (nextChild = new FakeChild());
    const promise = runClaudeCodeAction.execute({
      params: { mode: 'ask', prompt: 'hi' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    await new Promise((r) => setTimeout(r, 10));
    finishChild(child, { stdout: '', stderr: 'boom', code: 2 });
    await expect(promise).rejects.toThrow(/exit 2/);
  });

  it('resolves (not rejects) when exit is non-zero but stdout has content', async () => {
    // Some claude sessions exit with non-zero but still produce a useful
    // response. We preserve it rather than swallowing it.
    const child = (nextChild = new FakeChild());
    const promise = runClaudeCodeAction.execute({
      params: { mode: 'ask', prompt: 'hi' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    await new Promise((r) => setTimeout(r, 10));
    finishChild(child, { stdout: 'partial answer', code: 1 });
    const result = await promise;
    expect(result.data.response).toBe('partial answer');
    expect(result.data.exit_code).toBe(1);
  });

  it('rejects immediately when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runClaudeCodeAction.execute({
        params: { mode: 'ask', prompt: 'hi' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(controller.signal),
      }),
    ).rejects.toThrow('Aborted');
  });

  it('kills the subprocess and rejects on mid-flight abort', async () => {
    const controller = new AbortController();
    nextChild = new FakeChild();
    const child = nextChild;
    const promise = runClaudeCodeAction.execute({
      params: { mode: 'ask', prompt: 'hi' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(controller.signal),
    });
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await expect(promise).rejects.toThrow('Aborted');
    expect(child.killed).toBe(true);
  });
});
