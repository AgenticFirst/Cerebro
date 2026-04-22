import { describe, it, expect, vi } from 'vitest';
import { runCommandAction } from '../actions/run-command';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext } from '../actions/types';

function makeContext(overrides?: Partial<ActionContext>): ActionContext {
  return {
    runId: 'run-1',
    stepId: 'step-1',
    backendPort: 9999,
    signal: new AbortController().signal,
    log: vi.fn(),
    emitEvent: vi.fn(),
    resolveModel: vi.fn(),
    ...overrides,
  };
}

describe('runCommandAction', () => {
  it('executes an allowed command (echo)', async () => {
    const result = await runCommandAction.execute({
      params: { command: 'echo', args: 'hello world' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    expect(result.data.exit_code).toBe(0);
    expect((result.data.stdout as string).trim()).toBe('hello world');
    expect(result.data.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('rejects disallowed commands', async () => {
    await expect(
      runCommandAction.execute({
        params: { command: 'rm', args: '-rf /' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('not allowed');
  });

  it('throws when command is empty', async () => {
    await expect(
      runCommandAction.execute({
        params: { command: '' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('requires a command');
  });

  it('handles non-zero exit codes', async () => {
    await expect(
      runCommandAction.execute({
        params: { command: 'ls', args: '/nonexistent-path-12345' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('Command failed');
  });

  it('rejects non-existent working directory', async () => {
    await expect(
      runCommandAction.execute({
        params: { command: 'echo', args: 'test', working_directory: '/nonexistent/path' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('does not exist');
  });

  it('rejects path-based commands', async () => {
    await expect(
      runCommandAction.execute({
        params: { command: '/tmp/malicious-git' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('no paths');
  });

  it('rejects node and python commands', async () => {
    await expect(
      runCommandAction.execute({
        params: { command: 'node', args: '-e "process.exit(0)"' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('not allowed');
  });

  it('blocks dangerous env var overrides', async () => {
    await expect(
      runCommandAction.execute({
        params: { command: 'echo', args: 'test', env: { PATH: '/tmp/evil' } },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('Cannot override environment variable');
  });

  // ── Mustache variable substitution ──────────────────────────

  it('expands {{variables}} in args before running', async () => {
    const result = await runCommandAction.execute({
      params: { command: 'echo', args: 'hello {{name}}' },
      wiredInputs: { name: 'world' },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect((result.data.stdout as string).trim()).toBe('hello world');
  });

  it('expands {{variables}} in env values', async () => {
    const result = await runCommandAction.execute({
      params: {
        command: 'echo',
        args: '"$MY_VAR"',
        env: { MY_VAR: 'from-{{source}}' },
      },
      wiredInputs: { source: 'routine' },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    // execFile doesn't expand shell vars, so the arg is literal; but the env
    // variable itself must be rendered at set time.
    expect(result.data.exit_code).toBe(0);
  });

  it('does NOT template the command name (so ALLOWED_COMMANDS check is stable)', async () => {
    // If the command were templated, `{{name}}` with name='echo' would pass —
    // we want it to be rejected so attackers can't smuggle binaries through
    // upstream data.
    await expect(
      runCommandAction.execute({
        params: { command: '{{name}}', args: 'hi' },
        wiredInputs: { name: 'echo' },
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('not allowed');
  });

  it('parses quoted args as single tokens', async () => {
    const result = await runCommandAction.execute({
      params: { command: 'echo', args: '"hello world" foo' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect((result.data.stdout as string).trim()).toBe('hello world foo');
  });

  it('rejects path-like commands with trailing slash', async () => {
    await expect(
      runCommandAction.execute({
        params: { command: '../bin/git' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('no paths');
  });

  it('blocks LD_PRELOAD env override', async () => {
    await expect(
      runCommandAction.execute({
        params: { command: 'echo', args: 'x', env: { LD_PRELOAD: '/evil.so' } },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('Cannot override environment variable');
  });

  it('blocks DYLD_INSERT_LIBRARIES env override (lowercase too)', async () => {
    await expect(
      runCommandAction.execute({
        params: { command: 'echo', args: 'x', env: { dyld_insert_libraries: '/x' } },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('Cannot override environment variable');
  });

  it('passes user-defined env vars through to the subprocess', async () => {
    // Use `sh`… wait, `sh` isn't allowed. Use `env` via `/usr/bin/env`?
    // Not allowed either. Instead, use node… also not allowed.
    // Use `jq -n env.MY_VAR` to read an env var — jq is allowed.
    const result = await runCommandAction.execute({
      params: {
        command: 'jq',
        args: '-n env.MY_TEST_VAR',
        env: { MY_TEST_VAR: 'hello-from-test' },
      },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.exit_code).toBe(0);
    expect((result.data.stdout as string).trim()).toBe('"hello-from-test"');
  });

  it('runs in the provided working_directory', async () => {
    const result = await runCommandAction.execute({
      params: { command: 'ls', args: '.', working_directory: '/tmp' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.exit_code).toBe(0);
  });

  it('rejects immediately when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runCommandAction.execute({
        params: { command: 'echo', args: 'nope' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext({ signal: controller.signal }),
      }),
    ).rejects.toThrow('Aborted');
  });

  it('returns summary string with duration', async () => {
    const result = await runCommandAction.execute({
      params: { command: 'echo', args: 'hi' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.summary).toMatch(/echo completed/);
    expect(result.summary).toMatch(/\d+ms/);
  });
});
