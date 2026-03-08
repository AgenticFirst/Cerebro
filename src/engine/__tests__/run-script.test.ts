import { describe, it, expect, vi } from 'vitest';
import { runScriptAction } from '../actions/run-script';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext } from '../actions/types';

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

describe('runScriptAction', () => {
  describe('JavaScript execution', () => {
    it('runs basic JavaScript and returns output', async () => {
      const result = await runScriptAction.execute({
        params: {
          language: 'javascript',
          code: 'output.result = input.x + input.y;',
          timeout: 5,
        },
        wiredInputs: { x: 3, y: 4 },
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      });

      expect((result.data.result as any).result).toBe(7);
      expect(result.data.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('captures console.log output', async () => {
      const result = await runScriptAction.execute({
        params: {
          language: 'javascript',
          code: 'console.log("hello"); output.done = true;',
          timeout: 5,
        },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      });

      expect(result.data.stdout).toBe('hello');
      expect((result.data.result as any).done).toBe(true);
    });

    it('throws on script error', async () => {
      await expect(
        runScriptAction.execute({
          params: {
            language: 'javascript',
            code: 'throw new Error("boom");',
            timeout: 5,
          },
          wiredInputs: {},
          scratchpad: new RunScratchpad(),
          context: makeContext(),
        }),
      ).rejects.toThrow('boom');
    });

    it('sandboxes dangerous APIs', async () => {
      await expect(
        runScriptAction.execute({
          params: {
            language: 'javascript',
            code: 'require("child_process").execSync("echo hacked");',
            timeout: 5,
          },
          wiredInputs: {},
          scratchpad: new RunScratchpad(),
          context: makeContext(),
        }),
      ).rejects.toThrow(); // require is not defined in sandbox
    });
  });

  it('throws when code is empty', async () => {
    await expect(
      runScriptAction.execute({
        params: { language: 'javascript', code: '' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('requires code');
  });
});
