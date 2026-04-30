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
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { RendererAgentEvent } from '../agents/types';
import type { QualityTier } from '../types/ipc';
import { getCachedClaudeCodeInfo } from './detector';
import { wrapClaudeSpawn } from '../sandbox/wrap-spawn';
import { buildSystemPrompt } from '../i18n/language-directive';
import { resolveBackendPythonBinDir, resolveBackendVirtualEnvRoot } from '../python/venv';

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
  /**
   * Cap on the number of turns the agent may take. Omitted from the
   * subprocess invocation when undefined, matching plain `claude -p`
   * (no cap). Callers that need a bounded operation — single-shot
   * distillations, routine steps — should pass an explicit value.
   */
  maxTurns?: number;
  /** Override the model (e.g. "sonnet", "opus", "claude-sonnet-4-6"). */
  model?: string;
  /** UI language code (e.g. "es"). When set and not "en", a language directive is appended to the system prompt. */
  language?: string;
  /** Quality vs. speed tier picked from the chat input chip. Drives a
   *  tier directive appended to the system prompt — flavored for Cerebro
   *  vs. a focused expert based on `agentName`. */
  qualityTier?: QualityTier;
}

/**
 * Manages a single Claude Code CLI subprocess.
 *
 * Events emitted:
 *  - 'event'  (RendererAgentEvent)
 *  - 'done'   (messageContent: string)
 *  - 'error'  (error: string)
 */
/**
 * Idle-watchdog timing. Without this, a hung subprocess (e.g., Claude Code
 * not authenticated) waits forever — the only safety net is the engine's
 * 5-minute step timeout, which produces a UUID-only error with no diagnosis.
 */
const IDLE_WARNING_MS = 30_000;
const IDLE_TIMEOUT_MS = 60_000;
// While a tool call is in flight, the subprocess is legitimately silent —
// it can't write the next stream-json line until the tool returns. The chat
// agent's `run-chat-action` skill blocks on human approval via a curl with
// `--max-time 1800`, so we mirror that ceiling here. The 60s idle policy is
// still right for "no tool open and the model has gone quiet" hangs.
const IDLE_TOOL_TIMEOUT_MS = 1_800_000;

export class ClaudeCodeRunner extends EventEmitter {
  private process: ChildProcess | null = null;
  private accumulatedText = '';
  private stderrTail = '';
  private stdoutTail = '';
  /**
   * Last `result.is_error: true` payload emitted on stdout as stream-json.
   * The CLI surfaces max-turns hits and per-turn API errors here rather
   * than on stderr, so capturing it lets the close handler produce a
   * legible message instead of falling through to "code 1".
   */
  private resultErrorTail = '';
  private agentNameUsed = '';
  private cwdUsed = '';
  private modelUsed = '';
  private maxTurnsUsed: number | null = null;
  private logStream: fs.WriteStream | null = null;
  private logPath = '';
  private killed = false;
  private closeHandled = false;
  private idleStartedAt = 0;
  private idleWarningTimer: ReturnType<typeof setTimeout> | null = null;
  private idleKillTimer: ReturnType<typeof setTimeout> | null = null;
  private idleWarned = false;
  private openToolCount = 0;
  private lastOpenToolName = '';

  start(options: ClaudeCodeRunOptions): void {
    const { runId, prompt, agentName, cwd } = options;
    this.agentNameUsed = agentName;
    this.cwdUsed = cwd;
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
      '--dangerously-skip-permissions',
      '--append-system-prompt', buildSystemPrompt(options.language, options.qualityTier, options.agentName),
    ];

    if (typeof options.maxTurns === 'number') {
      args.push('--max-turns', String(options.maxTurns));
    }
    this.maxTurnsUsed = options.maxTurns ?? null;

    args.push('--model', options.model || 'sonnet');
    this.modelUsed = options.model || 'sonnet';

    // Build env: inherit process.env but strip CLAUDECODE to avoid nested session error
    const env = { ...process.env } as Record<string, string>;
    delete env.CLAUDECODE;

    // Make the bundled / dev backend Python visible to the subprocess so the
    // agent's Bash tool can `import docx`, `import openpyxl`, etc. without a
    // setup step. Packages are pre-installed per backend/requirements.txt.
    const pyBin = resolveBackendPythonBinDir();
    if (pyBin) {
      env.PATH = `${pyBin}${path.delimiter}${env.PATH ?? ''}`;
      const venvRoot = resolveBackendVirtualEnvRoot();
      if (venvRoot) env.VIRTUAL_ENV = venvRoot;
      delete env.PYTHONHOME; // safety against host-Python bleed
    }

    const wrapped = wrapClaudeSpawn({ claudeBinary: info.path, claudeArgs: args });
    if (wrapped.sandboxed) {
      console.log(`[ClaudeCode:${runId.slice(0, 8)}] spawning under sandbox-exec`);
    }

    this.process = spawn(wrapped.binary, wrapped.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      env,
    });

    // Open a per-run log file before any stdio handlers fire so that even
    // an early crash leaves a debuggable artifact on disk. The chat error
    // surface only retains the last 500 chars of stderr in memory; this
    // file keeps the full transcript.
    this.openRunLog(runId, wrapped.binary, wrapped.args);

    // Start idle watchdog as soon as the subprocess is alive. The chat
    // path used to wait indefinitely for output; if the CLI hangs (most
    // commonly because the user isn't authenticated), no event would
    // ever fire. Now: 30s warns, 60s kills with a structured error.
    this.idleStartedAt = Date.now();
    this.armIdleTimers(runId);

    let buffer = '';

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.resetIdleTimers(runId);
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
      this.resetIdleTimers(runId);
      const text = data.toString();
      console.log(`[ClaudeCode:${runId.slice(0, 8)}] ${text.trim()}`);
      this.appendLog('stderr', text);
      // Keep last ~500 chars of stderr so we can surface the actual error
      this.stderrTail = (this.stderrTail + '\n' + text).slice(-500).trim();
      // Stream each non-empty stderr line as a structured event so the
      // Activity panel's live feed shows what the subprocess is saying
      // (e.g., auth prompts, model errors, sandbox issues).
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        this.emit('event', {
          type: 'subprocess_stderr',
          runId,
          line,
        } as RendererAgentEvent);
      }
    });

    this.process.on('close', (code, signal) => {
      if (this.closeHandled) return;
      this.closeHandled = true;
      this.clearIdleTimers();

      // Process remaining buffer
      if (buffer.trim()) {
        this.handleJsonLine(buffer.trim(), runId);
      }

      if (this.killed) return;

      // Treat non-zero exit codes AND signal kills as errors.
      // When a process is killed by a signal (e.g. sandbox-exec SIGABRT),
      // code is null and signal is set — this is NOT a success.
      // Note: on some platforms signal can be 0 (number) for normal exits — ignore that.
      const realSignal = signal && String(signal) !== '0' ? signal : null;
      const isError = (code !== 0 && code !== null) || realSignal != null;

      if (isError) {
        let detail: string;
        if (this.stderrTail.includes('max turns')) {
          detail = 'Claude Code reached the maximum number of turns without completing the task. Try a simpler request.';
        } else if (this.stderrTail.includes('rate limit') || this.stderrTail.includes('429')) {
          detail = 'Rate limited by the API. Please wait a moment and try again.';
        } else if (this.stderrTail.includes('authentication') || this.stderrTail.includes('401')) {
          detail = 'Authentication error. Check your API key in Settings.';
        } else if (signal) {
          detail = this.stderrTail
            ? `Claude Code was killed (${signal}): ${this.stderrTail}`
            : `Claude Code was killed by ${signal}`;
        } else if (this.stderrTail) {
          detail = `Claude Code error (code ${code}): ${this.stderrTail}`;
        } else if (this.resultErrorTail) {
          // Max-turns hits and per-turn API errors come through stream-json
          // as `result.is_error: true` rather than on stderr. Surface the
          // CLI's own message instead of the generic "exited unexpectedly".
          detail = `Claude Code error (code ${code}): ${this.resultErrorTail}`;
        } else if (this.stdoutTail) {
          // stderr was empty but stdout had a non-JSON line before exit —
          // that's almost always the actual error (e.g. "Unknown agent 'foo'").
          detail = `Claude Code error (code ${code}): ${this.stdoutTail}`;
        } else {
          // Last-resort fallback: emit everything we know about the run so
          // the user (and support) can debug without a transcript dump.
          const lines = [
            `Claude Code exited unexpectedly (code ${code}, no output)`,
            `  agent: ${this.agentNameUsed || '(unset)'}, model: ${this.modelUsed || '(unset)'}${this.maxTurnsUsed != null ? `, max-turns: ${this.maxTurnsUsed}` : ''}`,
            `  cwd: ${this.cwdUsed}`,
          ];
          if (this.logPath) lines.push(`  log: ${this.logPath}`);
          detail = lines.join('\n');
        }
        if (this.logPath && !detail.includes(this.logPath)) {
          detail += `\n\n(Details: ${this.logPath})`;
        }
        this.closeRunLog(`[exit] code=${code} signal=${signal ?? ''} detail=${detail.replace(/\n/g, ' ¶ ')}`);
        this.emit('event', { type: 'error', runId, error: detail } as RendererAgentEvent);
        this.emit('error', detail);
      } else {
        this.closeRunLog(`[exit] code=${code} signal=${signal ?? ''} ok`);
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
          const realSignal = signal && String(signal) !== '0' ? signal : null;
          const isError = (code !== 0 && code !== null) || realSignal != null;
          if (isError) {
            let detail = `Claude Code exited (code ${code}, signal ${signal})`;
            if (this.logPath) detail += `\n\n(Details: ${this.logPath})`;
            this.closeRunLog(`[exit-fallback] code=${code} signal=${signal ?? ''}`);
            this.emit('event', { type: 'error', runId, error: detail } as RendererAgentEvent);
            this.emit('error', detail);
          } else {
            this.closeRunLog(`[exit-fallback] code=${code} signal=${signal ?? ''} ok`);
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
      let detail = err.message;
      if (this.logPath) detail += `\n\n(Details: ${this.logPath})`;
      this.closeRunLog(`[spawn-error] ${err.message}`);
      this.emit('event', {
        type: 'error',
        runId,
        error: detail,
      } as RendererAgentEvent);
      this.emit('error', detail);
    });
  }

  abort(): void {
    this.killed = true;
    this.clearIdleTimers();
    this.closeRunLog('[abort] user cancelled');
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

  /**
   * Open <userData>/logs/claude-code/<runId>.log for the lifetime of this
   * run. We tee stderr and non-JSON stdout into it so that even when the
   * 500-char in-memory tails are empty at exit, the user has a real
   * artifact to share. Best-effort: failures to open are swallowed so a
   * disk issue can never break a chat run.
   */
  private openRunLog(runId: string, binary: string, args: readonly string[]): void {
    try {
      const userData = app.getPath('userData');
      const logDir = path.join(userData, 'logs', 'claude-code');
      fs.mkdirSync(logDir, { recursive: true });
      this.logPath = path.join(logDir, `${runId}.log`);
      this.logStream = fs.createWriteStream(this.logPath, { flags: 'w' });
      const ts = new Date().toISOString();
      // Redact --append-system-prompt body (can be long and is reproducible
      // from the same agent name); other args are short and safe.
      const safeArgs = args.map((a, i) => (args[i - 1] === '--append-system-prompt' ? '<system-prompt>' : a));
      this.logStream.write(`[${ts}] [start] ${binary} ${safeArgs.join(' ')}\n`);
      this.pruneOldLogs(logDir);
    } catch (err) {
      this.logStream = null;
      this.logPath = '';
      console.warn(`[ClaudeCode:${runId.slice(0, 8)}] could not open run log: ${(err as Error).message}`);
    }
  }

  private appendLog(channel: 'stdout' | 'stderr', text: string): void {
    if (!this.logStream) return;
    try {
      this.logStream.write(`[${channel}] ${text.endsWith('\n') ? text : text + '\n'}`);
    } catch {
      // Disk full / EBADF — give up on this run's log silently.
      this.logStream = null;
    }
  }

  private closeRunLog(footer: string): void {
    if (!this.logStream) return;
    try {
      this.logStream.write(`[${new Date().toISOString()}] ${footer}\n`);
      this.logStream.end();
    } catch {
      /* swallow */
    }
    this.logStream = null;
  }

  /**
   * Keep at most 50 run logs on disk. Logs are named `<runId>.log` and
   * sorted by mtime; oldest are unlinked. Best-effort, swallows errors.
   */
  private pruneOldLogs(logDir: string): void {
    try {
      const entries = fs
        .readdirSync(logDir)
        .filter((name) => name.endsWith('.log'))
        .map((name) => {
          const full = path.join(logDir, name);
          let mtime = 0;
          try {
            mtime = fs.statSync(full).mtimeMs;
          } catch {
            /* ignore */
          }
          return { full, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime);
      for (const stale of entries.slice(50)) {
        try {
          fs.unlinkSync(stale.full);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  /** Arm both idle timers from the current moment. The kill ceiling is
   *  IDLE_TIMEOUT_MS when no tool is in flight, IDLE_TOOL_TIMEOUT_MS while
   *  the subprocess is waiting on a tool result. The warning timer always
   *  fires at IDLE_WARNING_MS for visibility. */
  private armIdleTimers(runId: string): void {
    this.clearIdleTimers();
    this.idleWarned = false;
    this.idleStartedAt = Date.now();
    const toolOpen = this.openToolCount > 0;
    const killAt = toolOpen ? IDLE_TOOL_TIMEOUT_MS : IDLE_TIMEOUT_MS;
    this.idleWarningTimer = setTimeout(() => {
      if (this.killed || this.closeHandled || this.idleWarned) return;
      this.idleWarned = true;
      this.emit('event', {
        type: 'agent_idle_warning',
        runId,
        elapsedMs: Date.now() - this.idleStartedAt,
      } as RendererAgentEvent);
    }, IDLE_WARNING_MS);
    this.idleKillTimer = setTimeout(() => {
      if (this.killed || this.closeHandled) return;
      this.killed = true;
      this.clearIdleTimers();
      const ctx = this.agentNameUsed ? ` (agent='${this.agentNameUsed}')` : '';
      const stderrHint = this.stderrTail ? `\n\nLast stderr:\n${this.stderrTail.slice(-300)}` : '';
      const seconds = Math.round(killAt / 1000);
      let detail: string;
      if (toolOpen) {
        const toolHint = this.lastOpenToolName ? ` '${this.lastOpenToolName}'` : '';
        detail =
          `Claude Code subprocess was killed after ${seconds}s waiting on tool${toolHint}${ctx} to return. ` +
          `The tool either hung or — for approval-gated chat actions — no human responded in time.` +
          stderrHint;
      } else {
        detail =
          `Claude Code subprocess produced no output for ${seconds} seconds${ctx} and was killed. ` +
          `The most common cause is that Claude Code isn't authenticated — run \`claude\` in your terminal to check, then re-run this routine. ` +
          `If \`claude\` works fine, the model may be unavailable or the agent file may be malformed.` +
          stderrHint;
      }
      // Try graceful first, then force.
      if (this.process && !this.process.killed) {
        this.process.kill('SIGTERM');
        setTimeout(() => {
          if (this.process && !this.process.killed) this.process.kill('SIGKILL');
        }, 2000);
      }
      this.emit('event', { type: 'error', runId, error: detail } as RendererAgentEvent);
      this.emit('error', detail);
    }, killAt);
  }

  /** Reset idle timers — call from every stdout/stderr chunk. */
  private resetIdleTimers(runId: string): void {
    if (this.killed || this.closeHandled) return;
    this.armIdleTimers(runId);
  }

  private clearIdleTimers(): void {
    if (this.idleWarningTimer) { clearTimeout(this.idleWarningTimer); this.idleWarningTimer = null; }
    if (this.idleKillTimer) { clearTimeout(this.idleKillTimer); this.idleKillTimer = null; }
  }

  getAccumulatedText(): string {
    return this.accumulatedText;
  }

  private emitToolEnd(runId: string, toolCallId: string, toolName: string, content: unknown, isError: boolean): void {
    if (this.openToolCount > 0) this.openToolCount -= 1;
    if (this.openToolCount === 0) this.lastOpenToolName = '';
    this.armIdleTimers(runId);
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
      // Non-JSON line on stdout — usually an error string printed before the
      // CLI crashed. Keep the last ~500 chars so the close handler can surface
      // it instead of the generic "exited unexpectedly" fallback.
      this.stdoutTail = (this.stdoutTail + '\n' + line).slice(-500).trim();
      this.appendLog('stdout', line + '\n');
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
            this.openToolCount += 1;
            if (block.name) this.lastOpenToolName = block.name;
            this.armIdleTimers(runId);
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
      // Final result event — ensure we have the final text
      if (parsed.result) {
        if (!this.accumulatedText && typeof parsed.result === 'string') {
          this.accumulatedText = parsed.result;
        }
      }
      if (parsed.is_error === true) {
        // The CLI surfaces max-turns hits and per-turn API errors here
        // rather than on stderr. Capture the human-readable bits so the
        // close handler can produce a legible error message.
        const subtype = typeof parsed.subtype === 'string' ? parsed.subtype : '';
        const message =
          (typeof parsed.result === 'string' && parsed.result) ||
          (typeof parsed.error === 'string' && parsed.error) ||
          (typeof parsed.message === 'string' && parsed.message) ||
          subtype ||
          'unknown error';
        this.resultErrorTail =
          subtype && !message.toLowerCase().includes(subtype.toLowerCase())
            ? `${subtype}: ${message}`
            : message;
      }
      this.emit('event', {
        type: 'system',
        message: `Run completed (${parsed.num_turns ?? '?'} turns, ${parsed.duration_ms ? Math.round(parsed.duration_ms / 1000) + 's' : '?'})`,
        subtype: 'result',
      } as RendererAgentEvent);
    } else if (type === 'system') {
      // System events: init, config, etc.
      const msg = parsed.message || parsed.subtype || 'system';
      this.emit('event', {
        type: 'system',
        message: typeof msg === 'string' ? msg : JSON.stringify(msg),
        subtype: parsed.subtype,
      } as RendererAgentEvent);
    } else if (type === 'rate_limit_event') {
      this.emit('event', {
        type: 'system',
        message: `Rate limit: retry after ${parsed.retry_after ?? '?'}s`,
        subtype: 'rate_limit',
      } as RendererAgentEvent);
    } else if (type === 'tool_result' || type === 'tool_use_result') {
      // Top-level tool result (forward-compatibility path)
      const toolCallId = parsed.tool_use_id || parsed.id || '';
      const toolName = parsed.name || parsed.tool_name || '';
      this.emitToolEnd(runId, toolCallId, toolName, parsed.content, parsed.is_error === true);
    } else if (type === 'user' && parsed.message?.content && Array.isArray(parsed.message.content)) {
      // Tool results nested inside user messages
      for (const block of parsed.message.content) {
        if (block.type === 'tool_result') {
          this.emitToolEnd(runId, block.tool_use_id || '', '', block.content, block.is_error === true);
        }
      }
    } else if (type) {
      // Skip high-frequency noise events that add no user-visible information
      const SKIP = new Set(['content_block_start', 'content_block_stop', 'message_start', 'message_stop', 'ping', 'message_delta']);
      if (!SKIP.has(type)) {
        this.emit('event', {
          type: 'system',
          message: type,
          subtype: type,
        } as RendererAgentEvent);
      }
    }
  }
}
