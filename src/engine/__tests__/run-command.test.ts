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
});
