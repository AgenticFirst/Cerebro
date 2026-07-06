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
import { probeClaudeAuth } from './auth-probe';
import { toUuidFormat } from './session-id';
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
  /**
   * Stable Claude Code session identifier for this conversation. Derived
   * from the Cerebro `conversationId` so every turn of the same chat
   * lands in the same on-disk session file. Required: callers always pass
   * one (a fallback is to pass `runId`, which gives a one-shot session).
   */
  sessionId: string;
  /**
   * When true, spawn with `--resume <sessionId>` to continue an existing
   * Claude Code session — Claude Code reloads the full transcript on its
   * own, so no `<conversation_history>` injection is needed and no
   * `--agent` / `--append-system-prompt` is passed (those are baked into
   * the session at creation).
   *
   * When false (default), spawn with `--session-id <sessionId>` and pass
   * `--agent` + `--append-system-prompt` to create the session.
   */
  resume?: boolean;
  /**
   * Per-run environment overlay merged into the subprocess `env`. Used to
   * scope cross-cutting policies (e.g. the Slack bridge's per-user expert
   * allowlist) to a single run without leaking into the parent process or
   * other concurrent runs.
   */
  extraEnv?: Record<string, string>;
  /**
   * Absolute path to a per-run MCP config JSON (built by the caller from the
   * servers granted to this agent). Passed as `--mcp-config` together with
   * `--strict-mcp-config` so only Cerebro-managed servers ever load. Unlike
   * `--agent`, this is per-invocation — it is passed on resume too. Secrets
   * in the file are `${VAR}` placeholders resolved from `extraEnv`.
   */
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
/**
 * Idle-watchdog timing. Cerebro mirrors Claude Code itself here: the CLI
 * has no output-based timeout — it waits on the API stream indefinitely
 * (its own retry logic handles transient failures) and the subprocess
 * exits on its own when done or on terminal error. Long silences are
 * NORMAL on healthy runs: auto-compaction of a big session, a slow
 * --resume load, upstream backpressure. So once the subprocess has proven
 * alive, silence is never treated as death:
 *   - No output EVER: 90s boot-wedge kill. Total silence from spawn
 *     usually means the CLI is wedged before producing any output (an
 *     auth failure that didn't trip AUTH_STDERR_PATTERNS, or a hung
 *     connection). Classified 'auth' → login card.
 *   - Tool in flight: never killed. Bash, Edit, approval-gated chat
 *     actions can legitimately sit for hours.
 *   - Output seen, no tool open: 30-minute last-resort backstop. With
 *     --include-partial-messages, any healthy activity (generation,
 *     thinking, compaction chatter, the CLI's own retry logs on stderr)
 *     resets the timer — 30 minutes of TOTAL silence means a genuinely
 *     dead subprocess that would otherwise wedge the conversation's
 *     single-flight lock forever on unattended surfaces (Slack/Telegram
 *     have no Stop button). Classified 'idle_hang' → retried once.
 * Progressive warnings drive a "still thinking…" indicator in the UI and,
 * past the last fixed threshold, repeat every IDLE_WARNING_REPEAT_MS as a
 * heartbeat. The Slack/Telegram bridges count ANY forwarded event as run
 * activity, so this heartbeat is what keeps their own run reapers
 * (RUN_IDLE_TIMEOUT_MS, 5 min) from cancelling a healthy quiet run.
 */
const IDLE_WARNING_THRESHOLDS_MS = [45_000, 120_000, 300_000] as const;
const IDLE_WARNING_REPEAT_MS = 120_000;
const IDLE_BOOT_WEDGE_KILL_MS = 90_000;
const IDLE_NO_TOOL_KILL_MS = 30 * 60_000;
// Stderr substrings that indicate the Claude CLI cannot proceed because
// it is not authenticated. Matching one of these short-circuits the run
// with a clean "sign in" error instead of waiting for the backstop.
const AUTH_STDERR_PATTERNS = [
  'not authenticated',
  'not signed in',
  'please run',
  'claude login',
  'unauthorized',
  '401',
] as const;

/**
 * Classification of why a run ended. The chat-path runtime reads this
 * after the `error` event fires to decide whether to retry on a stronger
 * model/tier rung.
 */
export type { RunnerErrorClass } from '../engines/types';
import type { RunnerErrorClass } from '../engines/types';

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
  private idleWarningTimers: ReturnType<typeof setTimeout>[] = [];
  private idleWarningInterval: ReturnType<typeof setInterval> | null = null;
  private idleKillTimer: ReturnType<typeof setTimeout> | null = null;
  private openToolCount = 0;
  private lastOpenToolName = '';
  private lastErrorClass: RunnerErrorClass = 'unknown';
  /** Have we observed ANY stream-json event from the CLI yet? Used by the
   *  idle-watchdog to distinguish a boot-time auth wedge (no output ever)
   *  from a mid-run stall (the CLI did produce output, then went quiet). */
  private sawAnyOutput = false;

  /**
   * Classification of the most recent terminal state. Inspected by
   * AgentRuntime after `error` fires to decide whether to retry on a
   * stronger ladder rung.
   */
  getLastErrorClass(): RunnerErrorClass {
    return this.lastErrorClass;
  }

  start(options: ClaudeCodeRunOptions): void {
    // Async pre-flight, then synchronous spawn. The original API is
    // fire-and-forget (returns void; consumers subscribe via events), so we
    // wrap the auth probe in an async helper and surface a classified error
    // event when the probe fails. Avoids the 60 s silent-wedge that used to
    // leak a terminal instruction into Slack/Telegram surfaces.
    void this.startAsync(options);
  }

  private async startAsync(options: ClaudeCodeRunOptions): Promise<void> {
    const { runId, prompt, agentName, cwd } = options;
    this.agentNameUsed = agentName;
    this.cwdUsed = cwd;
    this.lastErrorClass = 'unknown';
    const info = getCachedClaudeCodeInfo();

    if (info.status !== 'available' || !info.path) {
      this.lastErrorClass = 'spawn';
      this.emit('event', {
        type: 'error',
        runId,
        error: 'Claude Code is not available',
      } as RendererAgentEvent);
      this.emit('error', 'Claude Code is not available');
      return;
    }

    // Pre-flight auth probe. If the CLI is unauthenticated, the cached
    // probe says so within 5 s (often 0 ms when cached). Short-circuit
    // here with `errorClass: 'auth'` so the chat renders the sign-in card
    // and the Slack/Telegram bridges route to the operator immediately —
    // no spawn, no 60 s wedge, no leaked "run claude in a terminal" hint.
    const probe = await probeClaudeAuth();
    if (!probe.ok) {
      this.lastErrorClass = 'auth';
      const error = 'Cerebro lost its Claude Code session.';
      this.emit('event', { type: 'error', runId, error } as RendererAgentEvent);
      this.emit('error', error);
      return;
    }

    // Session flags: --resume reloads an existing on-disk session (full
    // transcript intact), --session-id creates a new one. On resume,
    // --agent and --append-system-prompt are session-bound — they were
    // set when the session was created and Claude Code rejects/ignores
    // them on the resume call, so we deliberately omit them.
    const sessionUuid = toUuidFormat(options.sessionId);
    const args: string[] = [];
    if (options.resume) {
      args.push('--resume', sessionUuid);
    } else {
      args.push('--session-id', sessionUuid);
    }
    args.push('-p', prompt);
    if (!options.resume) {
      args.push('--agent', agentName);
      args.push(
        '--append-system-prompt',
        buildSystemPrompt(options.language, options.qualityTier, options.agentName),
      );
    }
    args.push('--output-format', 'stream-json');
    args.push('--verbose');
    // Stream partial message chunks (text/thinking deltas + tool-input
    // input_json_delta) as they generate. Without this, the CLI only writes
    // stdout at whole-assistant-message boundaries, so a single large turn —
    // a big Write/Edit whose tool input is the entire new file, or a long
    // thinking block — produces NO stdout and opens no tool for the duration
    // of generation. Partial chunks keep stdout flowing so resetIdleTimers()
    // fires throughout, leaving the no-tool backstop to catch only true
    // silence (a genuinely dead subprocess). Valid only with
    // --output-format=stream-json (already set above).
    args.push('--include-partial-messages');
    args.push('--dangerously-skip-permissions');

    // MCP servers granted to this agent (Google Drive, custom). Strict mode
    // keeps a user's machine-wide ~/.claude.json servers out of Cerebro runs —
    // agent `tools:` allowlists already block their tools, this blocks the
    // boot cost too. Per-invocation (unlike --agent): passed on resume as well.
    if (options.mcpConfigPath) {
      args.push('--mcp-config', options.mcpConfigPath);
      args.push('--strict-mcp-config');
    }

    if (typeof options.maxTurns === 'number') {
      args.push('--max-turns', String(options.maxTurns));
    }
    this.maxTurnsUsed = options.maxTurns ?? null;

    args.push('--model', options.model || 'sonnet');
    this.modelUsed = options.model || 'sonnet';

    // Build env: inherit process.env but strip CLAUDECODE to avoid nested session error
    const env = { ...process.env } as Record<string, string>;
    delete env.CLAUDECODE;
    if (options.extraEnv) {
      for (const [k, v] of Object.entries(options.extraEnv)) {
        if (typeof v === 'string') env[k] = v;
      }
    }

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

    // Arm progressive "still thinking…" warnings + a 30-minute kill
    // backstop. Auth hangs (the original watchdog motivation) are caught
    // earlier by checkAuthFailure() on the stderr handler.
    this.idleStartedAt = Date.now();
    this.armIdleTimers(runId);

    let buffer = '';

    this.process.stdout?.on('data', (chunk: Buffer) => {
      // Flip sawAnyOutput BEFORE re-arming the idle timers: armIdleTimers
      // branches the kill delay on it, and the first chunk (the init event)
      // must already arm the generous mid-run backstop, not the 90s
      // boot-wedge kill — otherwise a stall right after init (auto-compaction
      // on --resume of a big session) still dies at 90s.
      this.sawAnyOutput = true;
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
      // Fast-fail on auth markers instead of waiting for the 30-min backstop.
      // Returns true if we handled it; further stderr events still emit
      // (subprocess will exit imminently) but we don't double-fire.
      this.checkAuthFailure(text, runId);
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
      // Also treat a captured `result.is_error: true` payload as an error even
      // when the process exits 0: the CLI reports per-turn API errors (e.g. a
      // 401) as `{ subtype: "success", is_error: true, result: "Failed to
      // authenticate…" }` and still exits 0. Without this, that 401 text leaks
      // out as a normal assistant reply instead of routing to the auth class.
      const realSignal = signal && String(signal) !== '0' ? signal : null;
      const isError =
        (code !== 0 && code !== null) || realSignal != null || this.resultErrorTail.length > 0;

      if (isError) {
        let detail: string;
        const tailLower = (
          this.stderrTail +
          ' ' +
          this.resultErrorTail +
          ' ' +
          this.stdoutTail
        ).toLowerCase();
        // Resume target missing on disk — surface as a distinct class so the
        // runtime can transparently fall back to --session-id and seed the
        // new session with full conversation history from SQLite.
        const sessionMissingPatterns = [
          'no conversation found',
          'no such session',
          'session not found',
          'could not find session',
          'unknown session',
          'session does not exist',
        ];
        if (sessionMissingPatterns.some((p) => tailLower.includes(p))) {
          detail = 'Claude Code session not found — restoring from conversation history.';
          this.lastErrorClass = 'session_missing';
          this.closeRunLog(`[exit] code=${code} signal=${signal ?? ''} session_missing`);
          this.emit('event', { type: 'error', runId, error: detail } as RendererAgentEvent);
          this.emit('error', detail);
          return;
        }
        // The mirror of session_missing: we spawned with --session-id to
        // create a session whose id already exists on disk (the deterministic
        // per-conversation id was created by an earlier turn). The runtime
        // recovers by retrying the same id with --resume.
        if (
          tailLower.includes('already in use') ||
          (tailLower.includes('session id') && tailLower.includes('in use'))
        ) {
          detail = 'Reattaching to the existing Claude Code session.';
          this.lastErrorClass = 'session_in_use';
          this.closeRunLog(`[exit] code=${code} signal=${signal ?? ''} session_in_use`);
          this.emit('event', { type: 'error', runId, error: detail } as RendererAgentEvent);
          this.emit('error', detail);
          return;
        }
        if (this.resultErrorTail) {
          // Max-turns hits and per-turn API errors come through stream-json
          // as `result.is_error: true`. Classify off the message so retry
          // logic still works, then prefer a canned, user-actionable
          // message for the known classes — the raw CLI text (often
          // prefixed with `success:` or with a long API stack trace) is
          // confusing to surface in chat.
          const lower = this.resultErrorTail.toLowerCase();
          if (lower.includes('max turns') || lower.includes('max_turns')) {
            this.lastErrorClass = 'max_turns';
            detail =
              'Claude Code reached the maximum number of turns without completing the task. Try a simpler request.';
          } else if (
            lower.includes('context') &&
            (lower.includes('length') || lower.includes('window') || lower.includes('limit'))
          ) {
            this.lastErrorClass = 'context';
            detail =
              'Claude Code ran out of context window. The conversation is too long for this model.';
          } else if (
            lower.includes('rate limit') ||
            lower.includes('overload') ||
            lower.includes('429') ||
            lower.includes('503')
          ) {
            this.lastErrorClass = 'overload';
            detail = 'Rate limited or overloaded by the API. Please wait a moment and try again.';
          } else if (
            lower.includes('authentication') ||
            lower.includes('401') ||
            lower.includes('not authenticated') ||
            lower.includes('unauthorized') ||
            lower.includes('invalid api key')
          ) {
            this.lastErrorClass = 'auth';
            detail = 'Cerebro lost its Claude Code session.';
          } else {
            this.lastErrorClass = 'unknown';
            detail = `Claude Code error (code ${code}): ${this.resultErrorTail}`;
          }
        } else if (tailLower.includes('max turns') || tailLower.includes('max_turns')) {
          detail =
            'Claude Code reached the maximum number of turns without completing the task. Try a simpler request.';
          this.lastErrorClass = 'max_turns';
        } else if (
          tailLower.includes('context') &&
          (tailLower.includes('length') ||
            tailLower.includes('window') ||
            tailLower.includes('limit'))
        ) {
          detail =
            'Claude Code ran out of context window. The conversation is too long for this model.';
          this.lastErrorClass = 'context';
        } else if (
          tailLower.includes('rate limit') ||
          tailLower.includes('overload') ||
          tailLower.includes('429') ||
          tailLower.includes('503')
        ) {
          detail = 'Rate limited or overloaded by the API. Please wait a moment and try again.';
          this.lastErrorClass = 'overload';
        } else if (
          tailLower.includes('authentication') ||
          tailLower.includes('401') ||
          tailLower.includes('not authenticated') ||
          tailLower.includes('unauthorized') ||
          tailLower.includes('invalid api key')
        ) {
          detail = 'Cerebro lost its Claude Code session.';
          this.lastErrorClass = 'auth';
        } else if (signal) {
          detail = this.stderrTail
            ? `Claude Code was killed (${signal}): ${this.stderrTail}`
            : `Claude Code was killed by ${signal}`;
          this.lastErrorClass = 'unknown';
        } else if (this.stderrTail) {
          detail = `Claude Code error (code ${code}): ${this.stderrTail}`;
          this.lastErrorClass = 'unknown';
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
        this.closeRunLog(
          `[exit] code=${code} signal=${signal ?? ''} detail=${detail.replace(/\n/g, ' ¶ ')}`,
        );
        this.emit('event', { type: 'error', runId, error: detail } as RendererAgentEvent);
        this.emit('error', detail);
      } else {
        this.lastErrorClass = 'none';
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
          const isError =
            (code !== 0 && code !== null) || realSignal != null || this.resultErrorTail.length > 0;
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
      this.lastErrorClass = 'spawn';
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
    this.lastErrorClass = 'cancelled';
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
      const safeArgs = args.map((a, i) =>
        args[i - 1] === '--append-system-prompt' ? '<system-prompt>' : a,
      );
      this.logStream.write(`[${ts}] [start] ${binary} ${safeArgs.join(' ')}\n`);
      this.pruneOldLogs(logDir);
    } catch (err) {
      this.logStream = null;
      this.logPath = '';
      console.warn(
        `[ClaudeCode:${runId.slice(0, 8)}] could not open run log: ${(err as Error).message}`,
      );
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

  /** Arm progressive idle warnings (45s/2m/5m, then a repeating heartbeat
   *  every IDLE_WARNING_REPEAT_MS) and — only when no tool is in flight — a
   *  kill backstop: 90s before any output ever (boot wedge → 'auth'), 30
   *  minutes after output has been seen ('idle_hang'). A tool in flight is
   *  never killed on silence. Warnings past the active kill threshold are
   *  suppressed since they'd never fire. */
  private armIdleTimers(runId: string): void {
    this.clearIdleTimers();
    this.idleStartedAt = Date.now();
    const hasOpenTool = this.openToolCount > 0;
    const killMs = hasOpenTool
      ? null
      : this.sawAnyOutput
        ? IDLE_NO_TOOL_KILL_MS
        : IDLE_BOOT_WEDGE_KILL_MS;
    const emitWarning = (): void => {
      if (this.killed || this.closeHandled) return;
      this.emit('event', {
        type: 'agent_idle_warning',
        runId,
        elapsedMs: Date.now() - this.idleStartedAt,
      } as RendererAgentEvent);
    };
    const lastThreshold = IDLE_WARNING_THRESHOLDS_MS[IDLE_WARNING_THRESHOLDS_MS.length - 1];
    for (const threshold of IDLE_WARNING_THRESHOLDS_MS) {
      if (killMs != null && threshold >= killMs) continue;
      this.idleWarningTimers.push(setTimeout(emitWarning, threshold));
    }
    // Heartbeat: past the last fixed threshold, keep emitting a warning every
    // IDLE_WARNING_REPEAT_MS for as long as the silence lasts. Besides keeping
    // the "still thinking…" indicator honest, this keeps events flowing to the
    // Slack/Telegram bridges, whose run reapers cancel any run with no events
    // for RUN_IDLE_TIMEOUT_MS — without the heartbeat they'd reap a healthy
    // quiet run (long compaction, approval-gated tool wait) after the 5m
    // warning went silent.
    this.idleWarningInterval = setInterval(() => {
      if (Date.now() - this.idleStartedAt <= lastThreshold) return;
      emitWarning();
    }, IDLE_WARNING_REPEAT_MS);
    if (killMs == null) return;
    this.idleKillTimer = setTimeout(() => {
      if (this.killed || this.closeHandled) return;
      this.killed = true;
      this.clearIdleTimers();
      const ctx = this.agentNameUsed ? ` (agent='${this.agentNameUsed}')` : '';
      const stderrHint = this.stderrTail ? `\n\nLast stderr:\n${this.stderrTail.slice(-300)}` : '';
      let detail: string;
      if (!this.sawAnyOutput) {
        // Nothing has ever come back from the CLI — this is the classic
        // unauthenticated-CLI wedge: the subprocess silently waits on stdin
        // for OAuth credentials that will never arrive. Classify as 'auth'
        // so the chat surfaces the login card instead of a terminal
        // instruction the user can't act on (especially over
        // Slack/Telegram). The message is intentionally short and
        // surface-agnostic; the consumer renders the recovery affordance.
        detail = 'Cerebro lost its Claude Code session.';
        this.lastErrorClass = 'auth';
      } else {
        // The CLI produced output, then fell TOTALLY silent for the full
        // backstop window with no tool open. Healthy runs can't do this —
        // partial-message deltas, compaction chatter, and the CLI's own
        // retry logs all reset the timer — so the subprocess is genuinely
        // dead. Classify as a retryable idle_hang: the runtime re-spawns
        // once rather than surfacing the raw "produced no output" string.
        const minutes = Math.round(IDLE_NO_TOOL_KILL_MS / 60_000);
        detail =
          `Claude Code produced no output for ${minutes} minutes${ctx} and was killed.` +
          stderrHint;
        this.lastErrorClass = 'idle_hang';
      }
      if (this.process && !this.process.killed) {
        this.process.kill('SIGTERM');
        // Give the CLI a real chance to flush + release its on-disk session
        // lock before we SIGKILL. A SIGKILLed process orphans the lock, which
        // wedges the next turn with "Session ID … is already in use" until the
        // session-recovery path rotates it. 5s matches abort()'s grace.
        setTimeout(() => {
          if (this.process && !this.process.killed) this.process.kill('SIGKILL');
        }, 5000);
      }
      this.emit('event', { type: 'error', runId, error: detail } as RendererAgentEvent);
      this.emit('error', detail);
    }, killMs);
  }

  /** Reset idle timers — call from every stdout/stderr chunk. */
  private resetIdleTimers(runId: string): void {
    if (this.killed || this.closeHandled) return;
    this.armIdleTimers(runId);
  }

  private clearIdleTimers(): void {
    for (const t of this.idleWarningTimers) clearTimeout(t);
    this.idleWarningTimers = [];
    if (this.idleWarningInterval) {
      clearInterval(this.idleWarningInterval);
      this.idleWarningInterval = null;
    }
    if (this.idleKillTimer) {
      clearTimeout(this.idleKillTimer);
      this.idleKillTimer = null;
    }
  }

  /** Inspect a stderr chunk for the Claude CLI's auth-failure markers.
   *  Returns true if we recognized an auth error and fast-failed the run. */
  private checkAuthFailure(text: string, runId: string): boolean {
    const lower = text.toLowerCase();
    if (!AUTH_STDERR_PATTERNS.some((p) => lower.includes(p))) return false;
    if (this.killed || this.closeHandled) return false;
    this.killed = true;
    this.clearIdleTimers();
    this.lastErrorClass = 'auth';
    const detail = 'Cerebro lost its Claude Code session.';
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
      setTimeout(() => {
        if (this.process && !this.process.killed) this.process.kill('SIGKILL');
      }, 1000);
    }
    this.emit('event', { type: 'error', runId, error: detail } as RendererAgentEvent);
    this.emit('error', detail);
    return true;
  }

  getAccumulatedText(): string {
    return this.accumulatedText;
  }

  private emitToolEnd(
    runId: string,
    toolCallId: string,
    toolName: string,
    content: unknown,
    isError: boolean,
  ): void {
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
      // Final result event — ensure we have the final text. Never adopt an
      // `is_error` result as the reply body: on auth/API failures the CLI puts
      // the raw error string here (and may still exit 0), so copying it would
      // surface "Failed to authenticate. API Error: 401 …" as a normal answer.
      if (parsed.result && parsed.is_error !== true) {
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
    } else if (
      type === 'user' &&
      parsed.message?.content &&
      Array.isArray(parsed.message.content)
    ) {
      // Tool results nested inside user messages
      for (const block of parsed.message.content) {
        if (block.type === 'tool_result') {
          this.emitToolEnd(
            runId,
            block.tool_use_id || '',
            '',
            block.content,
            block.is_error === true,
          );
        }
      }
    } else if (type) {
      // Skip high-frequency noise events that add no user-visible information
      const SKIP = new Set([
        'content_block_start',
        'content_block_stop',
        'message_start',
        'message_stop',
        'ping',
        'message_delta',
        // Partial message chunks (enabled via --include-partial-messages).
        // They keep stdout flowing so the idle-watchdog resets during long
        // generations; we don't surface them as system events (one per token
        // would flood the Activity panel). Reply text still accumulates from
        // the consolidated `assistant` message above.
        'stream_event',
      ]);
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
