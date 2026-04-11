/**
 * VoiceClaudeRunner — minimal Claude Code subprocess spawner scoped to voice.
 *
 * Unlike ClaudeCodeRunner (which uses --agent, memory directives, --max-turns 15),
 * this spawns `claude -p` with the lightest possible args:
 *   - No --agent → skip agent def load, memory Glob/Read, skill injection
 *   - --model claude-haiku-4-5 → fast first-token
 *   - --max-turns 1 → no tool loops
 *   - --disallowedTools → hard-block all tools at runtime level
 *   - --append-system-prompt → expert personality + voice instructions
 *
 * Expected time-to-first-text-delta: ~2-4 seconds (down from 10-50s).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { getCachedClaudeCodeInfo } from '../claude-code/detector';

export interface VoiceRunOptions {
  runId: string;
  userMessage: string;
  /** Expert system prompt + voice instructions, already assembled. */
  systemPrompt: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  model: string;
  /** Cerebro data dir — needed so `claude` finds its config. */
  cwd: string;
}

/**
 * Events emitted:
 *  - 'text_delta' (delta: string)
 *  - 'done'       (fullText: string)
 *  - 'error'      (error: string)
 */
export class VoiceClaudeRunner extends EventEmitter {
  private process: ChildProcess | null = null;
  private accumulatedText = '';
  private stderrTail = '';
  private killed = false;
  private closeHandled = false;

  start(options: VoiceRunOptions): void {
    const { runId, userMessage, systemPrompt, history, model, cwd } = options;
    const info = getCachedClaudeCodeInfo();

    if (info.status !== 'available' || !info.path) {
      this.emit('error', 'Claude Code is not available');
      return;
    }

    const prompt = buildVoicePrompt(userMessage, history);

    const args: string[] = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--max-turns', '1',
      '--model', model,
      '--dangerously-skip-permissions',
      '--append-system-prompt', systemPrompt,
      '--disallowedTools', 'Read,Write,Edit,Glob,Grep,Bash,WebFetch,WebSearch,Agent',
    ];

    // Inherit process.env but strip CLAUDECODE to avoid nested session error
    const env = { ...process.env } as Record<string, string>;
    delete env.CLAUDECODE;

    console.log(`[Voice:runner] Spawning claude for run ${runId.slice(0, 8)}`);
    const t0 = Date.now();

    this.process = spawn(info.path, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      env,
    });

    let buffer = '';

    this.process.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.handleJsonLine(trimmed, t0);
      }
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      console.log(`[Voice:runner:${runId.slice(0, 8)}] ${text}`);
      this.stderrTail = (this.stderrTail + '\n' + text).slice(-500).trim();
    });

    this.process.on('close', (code) => {
      if (this.closeHandled) return;
      this.closeHandled = true;

      // Process remaining buffer
      if (buffer.trim()) {
        this.handleJsonLine(buffer.trim(), t0);
      }

      if (this.killed) return;

      if (code !== 0 && code !== null) {
        let detail: string;
        if (this.stderrTail.includes('rate limit') || this.stderrTail.includes('429')) {
          detail = 'Rate limited by the API. Please wait a moment and try again.';
        } else if (this.stderrTail.includes('authentication') || this.stderrTail.includes('401')) {
          detail = 'Authentication error. Check your API key in Settings.';
        } else {
          detail = this.stderrTail
            ? `Claude Code error (code ${code}): ${this.stderrTail}`
            : `Claude Code exited unexpectedly (code ${code})`;
        }
        this.emit('error', detail);
      } else {
        console.log(`[Voice:runner] Done in ${Date.now() - t0}ms, ${this.accumulatedText.length} chars`);
        this.emit('done', this.accumulatedText);
      }
    });

    // Fallback: 'exit' fires when process exits even if stdio isn't fully closed
    this.process.on('exit', (code, signal) => {
      setTimeout(() => {
        if (!this.closeHandled && !this.killed) {
          this.closeHandled = true;
          if (code !== 0 && code !== null) {
            this.emit('error', `Claude Code exited (code ${code}, signal ${signal})`);
          } else {
            this.emit('done', this.accumulatedText);
          }
        }
      }, 5000);
    });

    this.process.on('error', (err) => {
      if (this.killed) return;
      this.emit('error', err.message);
    });
  }

  abort(): void {
    this.killed = true;
    if (!this.process || this.process.killed) return;

    this.process.kill('SIGTERM');

    const forceTimer = setTimeout(() => {
      if (this.process && !this.process.killed) {
        this.process.kill('SIGKILL');
      }
    }, 3000);

    this.process.once('exit', () => {
      clearTimeout(forceTimer);
    });
  }

  private firstDeltaLogged = false;

  private handleJsonLine(line: string, t0: number): void {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    const type = parsed.type;

    if (type === 'assistant' && parsed.message?.content && Array.isArray(parsed.message.content)) {
      for (const block of parsed.message.content) {
        if (block.type === 'text' && block.text) {
          if (!this.firstDeltaLogged) {
            console.log(`[Voice:runner] First text delta at +${Date.now() - t0}ms`);
            this.firstDeltaLogged = true;
          }
          this.accumulatedText += block.text;
          this.emit('text_delta', block.text);
        }
      }
    } else if (type === 'content_block_delta') {
      const delta = parsed.delta;
      if (delta?.type === 'text_delta' && delta.text) {
        if (!this.firstDeltaLogged) {
          console.log(`[Voice:runner] First text delta at +${Date.now() - t0}ms`);
          this.firstDeltaLogged = true;
        }
        this.accumulatedText += delta.text;
        this.emit('text_delta', delta.text);
      }
    } else if (type === 'result') {
      if (parsed.result && !this.accumulatedText && typeof parsed.result === 'string') {
        this.accumulatedText = parsed.result;
      }
    }
  }
}

/** Build the prompt body with conversation history + current user message. */
function buildVoicePrompt(
  userMessage: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
): string {
  if (history.length === 0) {
    return userMessage;
  }

  const historyXml = history
    .map((msg) => `<${msg.role}>${msg.content}</${msg.role}>`)
    .join('\n');

  return `<conversation_history>\n${historyXml}\n</conversation_history>\n\n${userMessage}`;
}
