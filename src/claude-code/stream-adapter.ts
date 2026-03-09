/**
 * ClaudeCodeRunner — spawns `claude -p` as a subprocess and translates
 * its stream-json NDJSON output into RendererAgentEvents.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import type { RendererAgentEvent } from '../agents/types';
import { getCachedClaudeCodeInfo } from './detector';

export interface ClaudeCodeRunOptions {
  runId: string;
  prompt: string;
  systemPrompt?: string;
  /** Working directory for Claude Code file operations. */
  cwd?: string;
  /** Path to MCP config JSON for Cerebro memory bridge. */
  mcpConfigPath?: string;
}

/**
 * Manages a single Claude Code CLI subprocess.
 *
 * Events emitted:
 *  - 'event'  (RendererAgentEvent)
 *  - 'done'   (messageContent: string)
 *  - 'error'  (error: string)
 */
export class ClaudeCodeRunner extends EventEmitter {
  private process: ChildProcess | null = null;
  private accumulatedText = '';
  private killed = false;

  start(options: ClaudeCodeRunOptions): void {
    const { runId, prompt, systemPrompt, cwd, mcpConfigPath } = options;
    const info = getCachedClaudeCodeInfo();

    if (info.status !== 'available' || !info.path) {
      this.emit('event', {
        type: 'error',
        runId,
        error: 'Claude Code is not available',
      } as RendererAgentEvent);
      return;
    }

    const args: string[] = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--max-turns', '15',
      '--no-session-persistence',
      '--allowedTools',
      'Read,Edit,Write,Bash,Grep,Glob,WebSearch,WebFetch,LSP',
    ];

    if (systemPrompt) {
      args.push('--append-system-prompt', systemPrompt);
    }

    if (mcpConfigPath) {
      args.push('--mcp-config', mcpConfigPath);
    }

    // Build env: inherit process.env but strip CLAUDECODE to avoid nested session error
    const env = { ...process.env } as Record<string, string>;
    delete env.CLAUDECODE;

    this.process = spawn(info.path, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: cwd || os.homedir(),
      env,
    });

    let buffer = '';

    this.process.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      // Keep last potentially incomplete line
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.handleJsonLine(trimmed, runId);
      }
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      // Log stderr but don't treat as fatal
      console.log(`[ClaudeCode:${runId.slice(0, 8)}] ${data.toString().trim()}`);
    });

    this.process.on('close', (code) => {
      // Process remaining buffer
      if (buffer.trim()) {
        this.handleJsonLine(buffer.trim(), runId);
      }

      if (this.killed) return;

      if (code !== 0 && code !== null) {
        this.emit('event', {
          type: 'error',
          runId,
          error: `Claude Code exited with code ${code}`,
        } as RendererAgentEvent);
        this.emit('error', `Claude Code exited with code ${code}`);
      } else {
        this.emit('event', {
          type: 'done',
          runId,
          messageContent: this.accumulatedText,
        } as RendererAgentEvent);
        this.emit('done', this.accumulatedText);
      }
    });

    this.process.on('error', (err) => {
      if (this.killed) return;
      this.emit('event', {
        type: 'error',
        runId,
        error: err.message,
      } as RendererAgentEvent);
      this.emit('error', err.message);
    });
  }

  abort(): void {
    this.killed = true;
    if (!this.process || this.process.killed) return;

    this.process.kill('SIGTERM');

    // Force kill after 3 seconds
    const forceTimer = setTimeout(() => {
      if (this.process && !this.process.killed) {
        this.process.kill('SIGKILL');
      }
    }, 3000);

    this.process.once('exit', () => {
      clearTimeout(forceTimer);
    });
  }

  getAccumulatedText(): string {
    return this.accumulatedText;
  }

  private handleJsonLine(line: string, runId: string): void {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Not JSON — ignore
      return;
    }

    // Claude Code stream-json format produces various event types
    // See: https://docs.anthropic.com/en/docs/claude-code/sdk#streaming-json-format
    const type = parsed.type;

    if (type === 'assistant' && parsed.message) {
      // Assistant message with content blocks
      const msg = parsed.message;
      if (msg.content && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            this.accumulatedText += block.text;
            this.emit('event', {
              type: 'text_delta',
              delta: block.text,
            } as RendererAgentEvent);
          } else if (block.type === 'tool_use') {
            this.emit('event', {
              type: 'tool_start',
              toolCallId: block.id,
              toolName: block.name,
              args: block.input,
            } as RendererAgentEvent);
          }
        }
      }
    } else if (type === 'content_block_delta') {
      // Streaming text delta
      const delta = parsed.delta;
      if (delta?.type === 'text_delta' && delta.text) {
        this.accumulatedText += delta.text;
        this.emit('event', {
          type: 'text_delta',
          delta: delta.text,
        } as RendererAgentEvent);
      }
    } else if (type === 'result') {
      // Final result event
      if (parsed.result) {
        // result contains the final text; we may have already accumulated it via deltas
        // Don't double-emit — just ensure we have the final text
        if (!this.accumulatedText && typeof parsed.result === 'string') {
          this.accumulatedText = parsed.result;
        }
      }
    } else if (type === 'tool_result' || type === 'tool_use_result') {
      // Tool execution result
      const toolCallId = parsed.tool_use_id || parsed.id || '';
      const toolName = parsed.name || parsed.tool_name || '';
      const isError = parsed.is_error === true;
      let result = '';
      if (typeof parsed.content === 'string') {
        result = parsed.content;
      } else if (Array.isArray(parsed.content)) {
        result = parsed.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n');
      }
      this.emit('event', {
        type: 'tool_end',
        toolCallId,
        toolName,
        result: result.slice(0, 2000),
        isError,
      } as RendererAgentEvent);
    }
  }
}
