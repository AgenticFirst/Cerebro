/**
 * run_command action — executes allowed shell commands.
 *
 * Uses execFile (NOT exec) to prevent shell injection.
 * Only whitelisted commands are allowed. `command` is NOT templated
 * so the ALLOWED_COMMANDS check can't be bypassed via upstream data.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { onAbort } from './utils/abort-helpers';
import { renderTemplate } from './utils/template';
import { ALLOWED_COMMANDS } from './run-command-allowlist';

interface RunCommandParams {
  command: string;
  args?: string;
  working_directory?: string;
  timeout?: number;
  env?: Record<string, string>;
}

const ALLOWED_COMMANDS_SET = new Set(ALLOWED_COMMANDS);

const BLOCKED_ENV_KEYS = new Set([
  'PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH', 'NODE_OPTIONS', 'PYTHONPATH',
]);

/**
 * Parse an args string into an array, respecting quoted strings.
 */
function parseArgs(argsStr: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote: string | null = null;

  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];

    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }

  if (current) args.push(current);
  return args;
}

export const runCommandAction: ActionDefinition = {
  type: 'run_command',
  name: 'Run Command',
  description: 'Executes a shell command from the allowed list.',

  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      args: { type: 'string' },
      working_directory: { type: 'string' },
      timeout: { type: 'number' },
      env: { type: 'object' },
    },
    required: ['command'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      stdout: { type: 'string' },
      stderr: { type: 'string' },
      exit_code: { type: 'number' },
      duration_ms: { type: 'number' },
    },
    required: ['stdout', 'stderr', 'exit_code'],
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as RunCommandParams;
    const { context } = input;
    const vars = input.wiredInputs ?? {};

    const command = (params.command ?? '').trim();
    if (!command) {
      throw new Error('Run command requires a command');
    }

    if (command.includes('/')) {
      throw new Error('Command must be a bare name (no paths). Use the command name directly.');
    }

    if (!ALLOWED_COMMANDS_SET.has(command)) {
      throw new Error(
        `Command "${command}" is not allowed. ` +
        `Allowed commands: ${ALLOWED_COMMANDS.join(', ')}`
      );
    }

    let renderedEnv: Record<string, string> | undefined;
    if (params.env) {
      renderedEnv = {};
      for (const [key, value] of Object.entries(params.env)) {
        if (BLOCKED_ENV_KEYS.has(key.toUpperCase())) {
          throw new Error(`Cannot override environment variable: ${key}`);
        }
        renderedEnv[key] = renderTemplate(value ?? '', vars);
      }
    }

    const renderedWorkingDir = params.working_directory
      ? renderTemplate(params.working_directory, vars).trim()
      : '';

    if (renderedWorkingDir && !existsSync(renderedWorkingDir)) {
      throw new Error(`Working directory does not exist: ${renderedWorkingDir}`);
    }

    const renderedArgs = params.args ? renderTemplate(params.args, vars) : '';
    const args = renderedArgs ? parseArgs(renderedArgs) : [];
    const timeoutMs = (params.timeout ?? 300) * 1000;
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      if (context.signal.aborted) {
        reject(new Error('Aborted'));
        return;
      }

      const child = execFile(
        command,
        args,
        {
          cwd: renderedWorkingDir || undefined,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024, // 10MB
          env: renderedEnv
            ? { ...process.env, ...renderedEnv }
            : process.env,
        },
        (error, stdout, stderr) => {
          removeAbortListener();
          const durationMs = Date.now() - startTime;
          const exitCode = error?.code
            ? (typeof error.code === 'number' ? error.code : 1)
            : 0;

          // Log stdout lines
          if (stdout) {
            const lines = stdout.split('\n').filter(Boolean);
            for (const line of lines.slice(0, 20)) {
              context.log(line);
            }
            if (lines.length > 20) {
              context.log(`... (${lines.length - 20} more lines)`);
            }
          }

          if (exitCode !== 0) {
            const errMsg = stderr || error?.message || `Exit code ${exitCode}`;
            reject(new Error(`Command failed (exit ${exitCode}): ${errMsg.slice(0, 200)}`));
            return;
          }

          resolve({
            data: {
              stdout: stdout || '',
              stderr: stderr || '',
              exit_code: exitCode,
              duration_ms: durationMs,
            },
            summary: `${command} completed (${durationMs}ms)`,
          });
        },
      );

      // Handle cancellation
      const removeAbortListener = onAbort(context.signal, () => {
        child.kill('SIGTERM');
        reject(new Error('Aborted'));
      });
    });
  },
};
