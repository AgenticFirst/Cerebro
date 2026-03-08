/**
 * run_script action — executes Python or JavaScript code.
 *
 * Python: delegates to backend /scripts/execute endpoint.
 * JavaScript: runs in a Node.js vm.Script sandbox (client-side).
 */

import vm from 'node:vm';
import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { backendFetch } from './utils/backend-fetch';

interface RunScriptParams {
  language: 'python' | 'javascript';
  code: string;
  timeout?: number;
}

export const runScriptAction: ActionDefinition = {
  type: 'run_script',
  name: 'Run Script',
  description: 'Executes Python or JavaScript code.',

  inputSchema: {
    type: 'object',
    properties: {
      language: { type: 'string', enum: ['python', 'javascript'] },
      code: { type: 'string' },
      timeout: { type: 'number' },
    },
    required: ['language', 'code'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      result: {},
      stdout: { type: 'string' },
      stderr: { type: 'string' },
      duration_ms: { type: 'number' },
    },
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as RunScriptParams;
    const { context } = input;

    if (!params.code?.trim()) {
      throw new Error('Script requires code to execute');
    }

    const language = params.language ?? 'python';
    const timeout = params.timeout ?? 30;

    if (language === 'python') {
      return executePython(params.code, input.wiredInputs, timeout, context);
    } else {
      return executeJavaScript(params.code, input.wiredInputs, timeout, context);
    }
  },
};

async function executePython(
  code: string,
  wiredInputs: Record<string, unknown>,
  timeout: number,
  context: ActionInput['context'],
): Promise<ActionOutput> {
  const response = await backendFetch<{
    result: Record<string, unknown> | null;
    stdout: string;
    stderr: string;
    exit_code: number;
    duration_ms: number;
  }>(
    context.backendPort,
    'POST',
    '/scripts/execute',
    {
      language: 'python',
      code,
      input_data: wiredInputs,
      timeout,
    },
    context.signal,
  );

  if (response.exit_code !== 0) {
    throw new Error(`Python script failed (exit ${response.exit_code}): ${response.stderr.slice(0, 200)}`);
  }

  if (response.stdout) {
    context.log(response.stdout.slice(0, 500));
  }

  return {
    data: {
      result: response.result ?? {},
      stdout: response.stdout,
      stderr: response.stderr,
      duration_ms: response.duration_ms,
    },
    summary: `Python script completed (${response.duration_ms}ms)`,
  };
}

function executeJavaScript(
  code: string,
  wiredInputs: Record<string, unknown>,
  timeout: number,
  context: ActionInput['context'],
): Promise<ActionOutput> {
  const startTime = Date.now();
  const logs: string[] = [];

  // Create sandboxed context with no prototype chain to prevent escapes
  const sandbox = Object.create(null) as Record<string, unknown>;
  sandbox.input = JSON.parse(JSON.stringify(wiredInputs)); // deep clone, no shared refs
  sandbox.output = {};

  // Expose safe subsets only (not the full constructor objects)
  sandbox.JSON = { parse: JSON.parse, stringify: JSON.stringify };
  sandbox.Math = Math;
  sandbox.parseInt = parseInt;
  sandbox.parseFloat = parseFloat;
  sandbox.isNaN = isNaN;
  sandbox.isFinite = isFinite;
  sandbox.console = {
    log: (...args: unknown[]) => {
      const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      logs.push(msg);
    },
  };

  try {
    const wrappedCode = `'use strict';\n${code}`;
    const script = new vm.Script(wrappedCode, { filename: 'user-script.js' });
    const vmContext = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    });
    script.runInContext(vmContext, { timeout: timeout * 1000 });

    const durationMs = Date.now() - startTime;
    const stdout = logs.join('\n');

    if (stdout) {
      context.log(stdout.slice(0, 500));
    }

    return Promise.resolve({
      data: {
        result: sandbox.output as Record<string, unknown>,
        stdout,
        stderr: '',
        duration_ms: durationMs,
      },
      summary: `JavaScript script completed (${durationMs}ms)`,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`JavaScript script failed: ${errMsg}`);
  }
}
