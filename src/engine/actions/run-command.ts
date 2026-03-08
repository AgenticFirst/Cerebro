/**
 * run_command action — executes allowed shell commands.
 *
 * Uses execFile (NOT exec) to prevent shell injection.
 * Only whitelisted commands are allowed.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { onAbort } from './utils/abort-helpers';

interface RunCommandParams {
  command: string;
  args?: string;
  working_directory?: string;
  timeout?: number;
  env?: Record<string, string>;
}

const ALLOWED_COMMANDS = new Set([
  'git', 'gh', 'npm', 'npx', 'pip',
  'claude', 'bun', 'pnpm', 'yarn', 'cargo', 'make', 'docker',
  'ls', 'cat', 'echo', 'curl', 'wget', 'jq',
]);

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

    if (!params.command) {
      throw new Error('Run command requires a command');
    }

    // Reject path-based commands — force bare command names only
    if (params.command.includes('/')) {
      throw new Error('Command must be a bare name (no paths). Use the command name directly.');
    }

    // Validate against allowed list
    if (!ALLOWED_COMMANDS.has(params.command)) {
      throw new Error(
        `Command "${params.command}" is not allowed. ` +
        `Allowed commands: ${[...ALLOWED_COMMANDS].join(', ')}`
      );
    }

    // Block dangerous env var overrides
    if (params.env) {
      for (const key of Object.keys(params.env)) {
        if (BLOCKED_ENV_KEYS.has(key.toUpperCase())) {
          throw new Error(`Cannot override environment variable: ${key}`);
        }
      }
    }

    // Validate working directory
    if (params.working_directory && !existsSync(params.working_directory)) {
      throw new Error(`Working directory does not exist: ${params.working_directory}`);
    }

    const args = params.args ? parseArgs(params.args) : [];
    const timeoutMs = (params.timeout ?? 300) * 1000;
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      if (context.signal.aborted) {
        reject(new Error('Aborted'));
        return;
      }

      const child = execFile(
        params.command,
        args,
        {
          cwd: params.working_directory || undefined,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024, // 10MB
          env: params.env
            ? { ...process.env, ...params.env }
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
            summary: `${params.command} completed (${durationMs}ms)`,
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
