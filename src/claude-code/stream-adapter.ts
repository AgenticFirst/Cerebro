/**
 * ClaudeCodeRunner — spawns `claude -p` as a subprocess and translates
 * its stream-json NDJSON output into RendererAgentEvents.
 *
 * Always launches with `cwd: <cerebro-data-dir>` so Claude Code
 * auto-discovers Cerebro's project-scoped subagents and skills under
 * `<cerebro-data-dir>/.claude/`. The subagent identified by `agentName`
 * defines its own system prompt and tools — no `--allowedTools`, no MCP
 * bridge. Uses `--dangerously-skip-permissions` since stdin is ignored
 * (interactive approval is impossible).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { RendererAgentEvent } from '../agents/types';
import { getCachedClaudeCodeInfo } from './detector';

export interface ClaudeCodeRunOptions {
  runId: string;
  prompt: string;
  /** Name of the project-scoped subagent to invoke (e.g. "cerebro" or "fitness-coach-ab12cd"). */
  agentName: string;
  /**
   * Working directory for the subprocess. MUST be Cerebro's data dir
   * (`app.getPath('userData')`) so Claude Code discovers .claude/agents/,
   * .claude/skills/, and .claude/settings.json.
   */
  cwd: string;
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
  private stderrTail = '';
  private killed = false;
  private closeHandled = false;

  start(options: ClaudeCodeRunOptions): void {
    const { runId, prompt, agentName, cwd } = options;
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
      '--agent', agentName,
      '--output-format', 'stream-json',
      '--verbose',
      '--max-turns', '15',
      '--dangerously-skip-permissions',
      '--append-system-prompt', 'CRITICAL: Never generate text on behalf of the user. Never output "User:" or simulate user messages. Your response ends when you have answered the request.',
    ];

    // Build env: inherit process.env but strip CLAUDECODE to avoid nested session error
    const env = { ...process.env } as Record<string, string>;
    delete env.CLAUDECODE;

    this.process = spawn(info.path, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
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
      const text = data.toString().trim();
      console.log(`[ClaudeCode:${runId.slice(0, 8)}] ${text}`);
      // Keep last ~500 chars of stderr so we can surface the actual error
      this.stderrTail = (this.stderrTail + '\n' + text).slice(-500).trim();
    });

    this.process.on('close', (code) => {
      if (this.closeHandled) return;
      this.closeHandled = true;

      // Process remaining buffer
      if (buffer.trim()) {
        this.handleJsonLine(buffer.trim(), runId);
      }

      if (this.killed) return;

      if (code !== 0 && code !== null) {
        let detail: string;
        if (this.stderrTail.includes('max turns')) {
          detail = 'Claude Code reached the maximum number of turns without completing the task. Try a simpler request.';
        } else if (this.stderrTail.includes('rate limit') || this.stderrTail.includes('429')) {
          detail = 'Rate limited by the API. Please wait a moment and try again.';
        } else if (this.stderrTail.includes('authentication') || this.stderrTail.includes('401')) {
          detail = 'Authentication error. Check your API key in Settings.';
        } else {
          detail = this.stderrTail
            ? `Claude Code error (code ${code}): ${this.stderrTail}`
            : `Claude Code exited unexpectedly (code ${code})`;
        }
        this.emit('event', { type: 'error', runId, error: detail } as RendererAgentEvent);
        this.emit('error', detail);
      } else {
        this.emit('event', {
          type: 'done',
          runId,
          messageContent: this.accumulatedText,
        } as RendererAgentEvent);
        this.emit('done', this.accumulatedText);
      }
    });

    // Fallback: 'exit' fires when process exits even if stdio isn't fully closed.
    // If 'close' hasn't fired within 5s of 'exit', force finalization.
    this.process.on('exit', (code, signal) => {
      setTimeout(() => {
        if (!this.closeHandled && !this.killed) {
          this.closeHandled = true;
          if (code !== 0 && code !== null) {
            const detail = `Claude Code exited (code ${code}, signal ${signal})`;
            this.emit('event', { type: 'error', runId, error: detail } as RendererAgentEvent);
            this.emit('error', detail);
          } else {
            this.emit('event', {
              type: 'done',
              runId,
              messageContent: this.accumulatedText,
            } as RendererAgentEvent);
            this.emit('done', this.accumulatedText);
          }
        }
      }, 5000);
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

  private emitToolEnd(toolCallId: string, toolName: string, content: unknown, isError: boolean): void {
    let result = '';
    if (typeof content === 'string') {
      result = content;
    } else if (Array.isArray(content)) {
      result = content
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

  private handleJsonLine(line: string, runId: string): void {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.debug(`[ClaudeCode:stream] non-JSON line: ${line.slice(0, 100)}`);
      return;
    }

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
      // Top-level tool result (forward-compatibility path)
      const toolCallId = parsed.tool_use_id || parsed.id || '';
      const toolName = parsed.name || parsed.tool_name || '';
      this.emitToolEnd(toolCallId, toolName, parsed.content, parsed.is_error === true);
    } else if (type === 'user' && parsed.message?.content && Array.isArray(parsed.message.content)) {
      // Tool results nested inside user messages
      for (const block of parsed.message.content) {
        if (block.type === 'tool_result') {
          this.emitToolEnd(block.tool_use_id || '', '', block.content, block.is_error === true);
        }
      }
    } else if (type) {
      console.debug(`[ClaudeCode:stream] unhandled event type: ${type}`);
    }
  }
}
