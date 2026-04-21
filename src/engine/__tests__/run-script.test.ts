import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runScriptAction } from '../actions/run-script';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext } from '../actions/types';

vi.mock('../actions/utils/backend-fetch', () => ({
  backendFetch: vi.fn(),
}));

import { backendFetch } from '../actions/utils/backend-fetch';

const mockFetch = vi.mocked(backendFetch);

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

beforeEach(() => {
  mockFetch.mockReset();
});

describe('runScriptAction', () => {
  describe('JavaScript execution', () => {
    // S-U1
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

      expect((result.data.result as { result: number }).result).toBe(7);
      expect(result.data.duration_ms).toBeGreaterThanOrEqual(0);
    });

    // S-U2
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
      expect((result.data.result as { done: boolean }).done).toBe(true);
    });

    // S-U3
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

    // S-U4 — require() must not be exposed in the sandbox
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
      ).rejects.toThrow();
    });

    // S-U8 — input must be a deep clone, not a shared reference
    it('input is a deep clone — mutations do not leak to wiredInputs', async () => {
      const wiredInputs: Record<string, unknown> = { items: [1, 2, 3], nested: { count: 0 } };
      await runScriptAction.execute({
        params: {
          language: 'javascript',
          code: 'input.items.push(99); input.nested.count = 42; output.done = true;',
          timeout: 5,
        },
        wiredInputs,
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      });
      // The outer wiredInputs object must not have been mutated by the script.
      expect(wiredInputs.items).toEqual([1, 2, 3]);
      expect((wiredInputs.nested as { count: number }).count).toBe(0);
    });

    // S-U9 — code-generation (Function ctor, eval) is disabled by createContext
    it('blocks Function/eval code generation in the sandbox', async () => {
      await expect(
        runScriptAction.execute({
          params: {
            language: 'javascript',
            // Classic Function-ctor escape hatch
            code: 'const F = (function(){}).constructor; F("return 1")();',
            timeout: 5,
          },
          wiredInputs: {},
          scratchpad: new RunScratchpad(),
          context: makeContext(),
        }),
      ).rejects.toThrow();
    });

    it('blocks process access even when the user tries `this.process`', async () => {
      await expect(
        runScriptAction.execute({
          params: {
            language: 'javascript',
            code: 'output.p = this.process.env;',
            timeout: 5,
          },
          wiredInputs: {},
          scratchpad: new RunScratchpad(),
          context: makeContext(),
        }),
      ).rejects.toThrow();
    });
  });

  describe('Python execution (backend delegation)', () => {
    // S-U6 — Python path delegates to backend and surfaces the response
    it('delegates to /scripts/execute with the expected payload', async () => {
      mockFetch.mockResolvedValueOnce({
        result: { answer: 42 },
        stdout: 'ok',
        stderr: '',
        exit_code: 0,
        duration_ms: 7,
      });

      const result = await runScriptAction.execute({
        params: {
          language: 'python',
          code: 'output["answer"] = 42',
          timeout: 12,
        },
        wiredInputs: { x: 1 },
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, method, path, body] = mockFetch.mock.calls[0];
      expect(method).toBe('POST');
      expect(path).toBe('/scripts/execute');
      expect(body).toEqual({
        language: 'python',
        code: 'output["answer"] = 42',
        input_data: { x: 1 },
        timeout: 12,
      });
      expect((result.data.result as { answer: number }).answer).toBe(42);
      expect(result.data.duration_ms).toBe(7);
    });

    // S-U7 — non-zero exit code surfaces as a thrown error with stderr head
    it('throws on non-zero exit, including stderr in the error message', async () => {
      mockFetch.mockResolvedValueOnce({
        result: null,
        stdout: '',
        stderr: 'Traceback: ValueError: boom',
        exit_code: 1,
        duration_ms: 3,
      });

      await expect(
        runScriptAction.execute({
          params: { language: 'python', code: 'raise ValueError("boom")' },
          wiredInputs: {},
          scratchpad: new RunScratchpad(),
          context: makeContext(),
        }),
      ).rejects.toThrow(/exit 1.*ValueError/);
    });

    it('defaults result to {} when the backend returns null', async () => {
      mockFetch.mockResolvedValueOnce({
        result: null,
        stdout: '',
        stderr: '',
        exit_code: 0,
        duration_ms: 1,
      });

      const result = await runScriptAction.execute({
        params: { language: 'python', code: 'x = 1' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      });

      expect(result.data.result).toEqual({});
    });
  });

  // S-U5 — empty code rejection applies to both languages
  describe('shared validation', () => {
    it('throws when code is empty (javascript)', async () => {
      await expect(
        runScriptAction.execute({
          params: { language: 'javascript', code: '' },
          wiredInputs: {},
          scratchpad: new RunScratchpad(),
          context: makeContext(),
        }),
      ).rejects.toThrow('requires code');
    });

    it('throws when code is only whitespace (python)', async () => {
      await expect(
        runScriptAction.execute({
          params: { language: 'python', code: '   \n   ' },
          wiredInputs: {},
          scratchpad: new RunScratchpad(),
          context: makeContext(),
        }),
      ).rejects.toThrow('requires code');
    });
  });
});
