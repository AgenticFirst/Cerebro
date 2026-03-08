/**
 * run_claude_code action — runs the Claude Code CLI as a subprocess.
 *
 * Supports modes: plan, implement, review, ask. Each mode restricts
 * the allowed tools accordingly.
 */

import { spawn, execFile } from 'node:child_process';
import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { onAbort } from './utils/abort-helpers';

interface ClaudeCodeParams {
  mode: 'plan' | 'implement' | 'review' | 'ask';
  prompt: string;
  working_directory?: string;
  max_turns?: number;
  timeout?: number;
}

const MODE_TOOLS: Record<string, string> = {
  plan: 'Read,Glob,Grep,Bash(git diff),Bash(git log)',
  implement: 'Read,Write,Edit,Glob,Grep,Bash',
  review: 'Read,Glob,Grep,Bash(git diff),Bash(git log),Bash(git status)',
  ask: 'Read,Glob,Grep',
};

const MODE_PREFIXES: Record<string, string> = {
  plan: 'Plan the implementation (do NOT write code): ',
  review: 'Review the following code changes: ',
};

// Only pass a curated set of env vars to the subprocess
const SAFE_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM',
  'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'ANTHROPIC_API_KEY', // Claude Code needs this
];

async function isClaudeAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('which', ['claude'], (error) => resolve(!error));
  });
}

export const runClaudeCodeAction: ActionDefinition = {
  type: 'run_claude_code',
  name: 'Claude Code',
  description: 'Runs the Claude Code CLI for AI-powered coding tasks.',

  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['plan', 'implement', 'review', 'ask'] },
      prompt: { type: 'string' },
      working_directory: { type: 'string' },
      max_turns: { type: 'number' },
      timeout: { type: 'number' },
    },
    required: ['prompt'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      response: { type: 'string' },
      exit_code: { type: 'number' },
      duration_ms: { type: 'number' },
      files_modified: { type: 'array' },
    },
    required: ['response', 'exit_code'],
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as ClaudeCodeParams;
    const { context } = input;

    if (!params.prompt) {
      throw new Error('Claude Code requires a prompt');
    }

    // Check if claude is available (async)
    const available = await isClaudeAvailable();
    if (!available) {
      throw new Error(
        'Claude Code CLI not found. Install it: npm install -g @anthropic-ai/claude-code'
      );
    }

    const mode = params.mode ?? 'ask';
    const allowedTools = MODE_TOOLS[mode] ?? MODE_TOOLS.ask;
    const prefix = MODE_PREFIXES[mode] ?? '';
    const fullPrompt = prefix + params.prompt;

    const args = [
      '--print',
      '--output-format', 'text',
      '--allowedTools', allowedTools,
    ];

    if (params.max_turns) {
      args.push('--max-turns', String(params.max_turns));
    }

    args.push(fullPrompt);

    const timeoutMs = (params.timeout ?? 600) * 1000;
    const startTime = Date.now();

    // Build a safe env subset
    const safeEnv: Record<string, string> = {};
    for (const key of SAFE_ENV_KEYS) {
      if (process.env[key]) safeEnv[key] = process.env[key]!;
    }

    return new Promise((resolve, reject) => {
      if (context.signal.aborted) {
        reject(new Error('Aborted'));
        return;
      }

      let stdout = '';
      let stderr = '';

      const child = spawn('claude', args, {
        cwd: params.working_directory || undefined,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: safeEnv,
      });

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) {
          stderr += line + '\n';
          context.log(line);
        }
      });

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Claude Code timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        removeAbortListener();
        const durationMs = Date.now() - startTime;

        // Extract file paths from output (best-effort)
        const filePathRegex = /(?:^|\s)((?:\/[\w.-]+)+|(?:[\w.-]+\/)+[\w.-]+)/gm;
        const matches = stdout.match(filePathRegex) ?? [];
        const filesModified = [...new Set(matches.map(m => m.trim()))].slice(0, 20);

        const response = stdout.trim();
        const exitCode = code ?? 0;

        if (exitCode !== 0 && !response) {
          reject(new Error(`Claude Code failed (exit ${exitCode}): ${stderr.slice(0, 200)}`));
          return;
        }

        resolve({
          data: {
            response,
            exit_code: exitCode,
            duration_ms: durationMs,
            files_modified: filesModified,
          },
          summary: `Claude Code (${mode}): ${response.slice(0, 60)}...`,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        removeAbortListener();
        reject(new Error(`Claude Code error: ${err.message}`));
      });

      // Handle cancellation
      const removeAbortListener = onAbort(context.signal, () => {
        clearTimeout(timer);
        child.kill('SIGTERM');
        reject(new Error('Aborted'));
      });
    });
  },
};
