import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

type StartArgs = {
  runId: string;
  prompt: string;
  agentName: string;
  cwd: string;
  sessionId?: string;
  resume?: boolean;
  _cwdAtStart?: string;
  _agentFileExistedAtStart?: boolean;
};

// Shared mutable state lifted via vi.hoisted so it's accessible from inside
// the hoisted vi.mock factories AND from test bodies.
const h = vi.hoisted(() => {
  const { EventEmitter: EE } = require('node:events') as typeof import('node:events');
  const fsMod = require('node:fs') as typeof import('node:fs');
  const pathMod = require('node:path') as typeof import('node:path');
  const runnerStarts: StartArgs[] = [];
  const runnerShouldError: { value: string | null } = { value: null };
  // Per-spawn programmable behavior. Each entry consumed in order; falls back
  // to `runnerShouldError` when the queue is empty. Use for tests that need
  // distinct outcomes across consecutive spawns (e.g. session_missing
  // recovery: first attempt errors, second succeeds).
  type NextBehavior =
    | { kind: 'done'; message?: string }
    | { kind: 'error'; error: string; errorClass: string };
  const runnerNextBehaviors: NextBehavior[] = [];
  class FakeClaudeCodeRunner extends EE {
    private errorClass = 'unknown';
    start(opts: StartArgs) {
      // Snapshot at spawn time: does the agent's .md file exist right now?
      const mdPath = pathMod.join(opts.cwd, '.claude', 'agents', `${opts.agentName}.md`);
      runnerStarts.push({
        ...opts,
        _cwdAtStart: opts.cwd,
        _agentFileExistedAtStart: fsMod.existsSync(mdPath),
      });
      const next = runnerNextBehaviors.shift();
      queueMicrotask(() => {
        if (next?.kind === 'error') {
          this.errorClass = next.errorClass;
          this.emit('event', { type: 'error', runId: opts.runId, error: next.error });
          this.emit('error', next.error);
        } else if (next?.kind === 'done') {
          this.emit('event', {
            type: 'done',
            runId: opts.runId,
            messageContent: next.message ?? '',
          });
          this.emit('done', next.message ?? '');
        } else if (runnerShouldError.value) {
          this.errorClass = 'unknown';
          this.emit('event', { type: 'error', runId: opts.runId, error: runnerShouldError.value });
          this.emit('error', runnerShouldError.value);
        } else {
          this.emit('event', { type: 'done', runId: opts.runId, messageContent: '' });
          this.emit('done', '');
        }
      });
    }
    getLastErrorClass() {
      return this.errorClass;
    }
    abort() {}
  }
  class FakeTaskPtyRunner extends EE {
    start() {}
    abort() {}
    isAborted() {
      return false;
    }
    write() {}
    resize() {}
  }
  class FakeTerminalBufferStore {
    constructor(_dir: string) {}
    append() {}
    flush() {}
  }
  return {
    runnerStarts,
    runnerShouldError,
    runnerNextBehaviors,
    FakeClaudeCodeRunner,
    FakeTaskPtyRunner,
    FakeTerminalBufferStore,
  };
});

const { runnerStarts, runnerShouldError, runnerNextBehaviors } = h;

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
}));

vi.mock('../claude-code/stream-adapter', () => ({
  ClaudeCodeRunner: h.FakeClaudeCodeRunner,
}));

vi.mock('../pty/TaskPtyRunner', () => ({
  TaskPtyRunner: h.FakeTaskPtyRunner,
}));
vi.mock('../pty/TerminalBufferStore', () => ({
  TerminalBufferStore: h.FakeTerminalBufferStore,
}));

// Import AFTER mocks are registered.
import { AgentRuntime } from './runtime';

function startBackend(
  experts: Array<{ id: string; name: string }>,
): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      const url = req.url || '';
      const match = url.match(/^\/experts\/([^/?]+)(\?|$)/);
      if (match) {
        const found = experts.find((e) => e.id === match[1]);
        if (!found) {
          res.statusCode = 404;
          res.end('{}');
          return;
        }
        res.statusCode = 200;
        res.end(JSON.stringify(found));
        return;
      }
      if (url.startsWith('/experts?')) {
        res.statusCode = 200;
        res.end(JSON.stringify({ experts }));
        return;
      }
      if (url.startsWith('/experts/') && url.endsWith('/skills')) {
        res.statusCode = 200;
        res.end(JSON.stringify({ skills: [] }));
        return;
      }
      if (url.startsWith('/agent-runs')) {
        res.statusCode = 200;
        res.end('{}');
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ port: addr.port, close: () => server.close() });
    });
  });
}

function makeSink() {
  const sent: Array<{ channel: string; payload: any }> = [];
  return {
    sink: {
      send: (channel: string, ...args: unknown[]) => {
        sent.push({ channel, payload: args[0] });
      },
      isDestroyed: () => false,
    },
    sent,
  };
}

describe('AgentRuntime.startRun — chat', () => {
  let dataDir: string;
  let backend: { port: number; close: () => void };

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebro-runtime-'));
    fs.mkdirSync(path.join(dataDir, '.claude', 'agents'), { recursive: true });
    backend = await startBackend([]);
    runnerStarts.length = 0;
    runnerShouldError.value = null;
    runnerNextBehaviors.length = 0;
  });

  afterEach(() => {
    backend.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('no expertId → spawns with agent "cerebro"', async () => {
    const rt = new AgentRuntime(backend.port, dataDir);
    const { sink } = makeSink();
    await rt.startRun(sink, {
      conversationId: 'c1',
      content: 'hey',
    } as any);
    await new Promise((r) => setTimeout(r, 20));
    expect(runnerStarts).toHaveLength(1);
    expect(runnerStarts[0].agentName).toBe('cerebro');
    expect(runnerStarts[0].cwd).toBe(dataDir);
  });

  it('delivers exactly one done event per successful run', async () => {
    // The real runner emits the completion on two channels — a generic
    // 'event' with type 'done' followed by the dedicated 'done' (the fake
    // above mirrors that). The runtime must forward only ONE done to the
    // sink: forwarding both made the Slack/Telegram sinks post the final
    // answer twice.
    const rt = new AgentRuntime(backend.port, dataDir);
    const { sink, sent } = makeSink();
    runnerNextBehaviors.push({ kind: 'done', message: 'final answer' });
    await rt.startRun(sink, {
      conversationId: 'c-single-done',
      content: 'hey',
    } as any);
    await new Promise((r) => setTimeout(r, 20));
    const doneEvents = sent.filter(
      (s) => s.channel.startsWith('agent:event:') && s.payload?.type === 'done',
    );
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0].payload.messageContent).toBe('final answer');
  });

  it('expertId "cerebro" → spawns the orchestrator agent without a persona file', async () => {
    // Selecting the builtin Cerebro expert as a task/step assignee must run the
    // main `cerebro` agent (which delegates), NOT try to resolve a materialized
    // persona slug — the Cerebro expert is intentionally never materialized, so
    // slug resolution would fail and the run would error. No index/.md is
    // installed here, proving the runtime short-circuits on the fixed id.
    const rt = new AgentRuntime(backend.port, dataDir);
    const { sink } = makeSink();
    await rt.startRun(sink, {
      conversationId: 'c-cerebro',
      content: 'plan the launch',
      expertId: 'cerebro',
    } as any);
    await new Promise((r) => setTimeout(r, 20));
    expect(runnerStarts).toHaveLength(1);
    expect(runnerStarts[0].agentName).toBe('cerebro');
  });

  it('exports CEREBRO_CONVERSATION_ID so run-chat-action.sh can stamp the approval', async () => {
    // run-chat-action.sh reads this env var and stamps it onto the action
    // request body; the engine then persists it on the run so the approval can
    // be approved inline in this exact conversation. Drop it here and inline
    // approvals silently regress to sidebar-only.
    const rt = new AgentRuntime(backend.port, dataDir);
    const { sink } = makeSink();
    await rt.startRun(sink, {
      conversationId: 'conv-stamp-1',
      content: 'create a ticket',
    } as any);
    await new Promise((r) => setTimeout(r, 20));
    expect(runnerStarts).toHaveLength(1);
    const extraEnv = (runnerStarts[0] as { extraEnv?: Record<string, string> }).extraEnv;
    expect(extraEnv?.CEREBRO_CONVERSATION_ID).toBe('conv-stamp-1');
  });

  it('expert in index AND file on disk → resolves from index, spawns', async () => {
    // Install an index + file manually
    const agentName = 'design-expert-abc123';
    fs.writeFileSync(
      path.join(dataDir, '.claude', 'agents', '.cerebro-index.json'),
      JSON.stringify({ experts: { 'e-1': agentName } }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(dataDir, '.claude', 'agents', `${agentName}.md`),
      '---\nname: design-expert-abc123\n---\n',
      'utf-8',
    );

    // Fresh module import so cachedIndex re-reads the new file.
    vi.resetModules();
    const { AgentRuntime: FreshRuntime } = await import('./runtime');

    const rt = new FreshRuntime(backend.port, dataDir);
    const { sink } = makeSink();
    await rt.startRun(sink, {
      conversationId: 'c1',
      content: 'hey',
      expertId: 'e-1',
    } as any);
    await new Promise((r) => setTimeout(r, 20));
    expect(runnerStarts).toHaveLength(1);
    expect(runnerStarts[0].agentName).toBe(agentName);
  });

  it('(pre-fix) expert not in index and file MISSING → spawns anyway with a re-derived slug that will fail', async () => {
    // Register the expert in the backend only, NOT in the on-disk index / files.
    backend.close();
    backend = await startBackend([{ id: 'e-missing', name: 'Missing Expert' }]);

    vi.resetModules();
    const { AgentRuntime: FreshRuntime } = await import('./runtime');

    const rt = new FreshRuntime(backend.port, dataDir);
    const { sink, sent } = makeSink();

    await rt.startRun(sink, {
      conversationId: 'c1',
      content: 'hey',
      expertId: 'e-missing',
    } as any);
    await new Promise((r) => setTimeout(r, 50));

    // Pre-fix behavior: runtime happily spawns with a re-derived slug even though
    // no .md exists on disk. Post-fix: runtime should either materialize the file
    // first, OR emit a structured "Expert not installed" error WITHOUT spawning.
    //
    // This assertion encodes the post-fix expectation. Red pre-fix, green post-fix.
    const errorEvents = sent.filter(
      (s) => s.channel.startsWith('agent:event:') && s.payload?.type === 'error',
    );
    // Use the snapshot taken AT SPAWN TIME — not after, because postRunSync()
    // calls installAll() asynchronously after the runner's done event, which
    // would materialize the file and mask the bug.
    const spawnedWithoutFile =
      runnerStarts.length > 0 && runnerStarts[0]._agentFileExistedAtStart === false;

    // Either the runtime materialized the file before spawning (preferred), or
    // it emitted a structured error. Both are acceptable; the *pre-fix* path of
    // spawning with a nonexistent agent file is not.
    if (spawnedWithoutFile) {
      // Fail loudly — this is exactly the bug we're fixing.
      throw new Error(
        'Runtime spawned Claude Code with a re-derived slug but the agent .md file does not exist on disk — this produces a generic "exited unexpectedly" error to the user.',
      );
    }

    if (runnerStarts.length > 0) {
      // If the runtime chose to materialize + spawn, the file must have existed
      // AT THE TIME OF SPAWN (not just materialized by the post-run sync).
      expect(runnerStarts[0]._agentFileExistedAtStart).toBe(true);
    } else {
      // If the runtime chose to not spawn, it must have emitted a structured error.
      expect(errorEvents.length).toBeGreaterThan(0);
      expect(errorEvents[0].payload.error).toMatch(/Expert not installed|not.*found/i);
    }
  });

  // ── --resume / session_missing regression tests ─────────────────
  // Bug: every new conversation surfaced
  //   "Error: Claude Code session not found — restoring from conversation history."
  // because the renderer included the just-typed user message in
  // recentMessages, the runtime read length>0 as "has prior turns" and
  // spawned with --resume against a session that did not yet exist on disk.
  // Then the runner's error event reached the renderer before the runtime
  // could spawn its session_missing recovery, pinning the error string as
  // the final assistant message.

  it('new conversation with no recentMessages → spawns with resume:false', async () => {
    const rt = new AgentRuntime(backend.port, dataDir);
    const { sink } = makeSink();
    await rt.startRun(sink, {
      conversationId: 'c-new-1',
      content: 'hola',
    } as any);
    await new Promise((r) => setTimeout(r, 20));
    expect(runnerStarts).toHaveLength(1);
    expect(runnerStarts[0].resume).toBe(false);
  });

  it('first turn with only a user message in recentMessages → still resume:false (no assistant turn yet)', async () => {
    const rt = new AgentRuntime(backend.port, dataDir);
    const { sink } = makeSink();
    await rt.startRun(sink, {
      conversationId: 'c-new-2',
      content: 'hola',
      recentMessages: [{ role: 'user', content: 'hola' }],
    } as any);
    await new Promise((r) => setTimeout(r, 20));
    expect(runnerStarts).toHaveLength(1);
    expect(runnerStarts[0].resume).toBe(false);
  });

  it('follow-up turn with a prior assistant message → resume:true', async () => {
    const rt = new AgentRuntime(backend.port, dataDir);
    const { sink } = makeSink();
    await rt.startRun(sink, {
      conversationId: 'c-follow',
      content: 'and now?',
      recentMessages: [
        { role: 'user', content: 'hola' },
        { role: 'assistant', content: 'hi!' },
      ],
    } as any);
    await new Promise((r) => setTimeout(r, 20));
    expect(runnerStarts).toHaveLength(1);
    expect(runnerStarts[0].resume).toBe(true);
  });

  it('session_missing on resume → spawns recovery with resume:false AND suppresses the error event to the renderer', async () => {
    // First spawn errors with session_missing; second spawn succeeds.
    runnerNextBehaviors.push(
      {
        kind: 'error',
        error: 'Claude Code session not found — restoring from conversation history.',
        errorClass: 'session_missing',
      },
      { kind: 'done', message: 'recovered output' },
    );

    const rt = new AgentRuntime(backend.port, dataDir);
    const { sink, sent } = makeSink();
    await rt.startRun(sink, {
      conversationId: 'c-recover',
      content: 'and now?',
      recentMessages: [
        { role: 'user', content: 'hola' },
        { role: 'assistant', content: 'hi!' },
      ],
    } as any);
    // Allow first spawn's error microtask + recovery spawn's done microtask to run.
    await new Promise((r) => setTimeout(r, 50));

    // Two spawns: the failed --resume, then the recovery --session-id.
    expect(runnerStarts).toHaveLength(2);
    expect(runnerStarts[0].resume).toBe(true);
    expect(runnerStarts[1].resume).toBe(false);

    // The renderer must NOT have seen the session_missing error — the
    // recovery's `done` event is what should reach the chat UI.
    const errorEvents = sent.filter(
      (s) => s.channel.startsWith('agent:event:') && s.payload?.type === 'error',
    );
    expect(errorEvents).toHaveLength(0);
    const doneEvents = sent.filter(
      (s) => s.channel.startsWith('agent:event:') && s.payload?.type === 'done',
    );
    expect(doneEvents.length).toBeGreaterThan(0);
    expect(doneEvents[doneEvents.length - 1].payload.messageContent).toBe('recovered output');
  });

  it('explicit resume hint overrides the recentMessages heuristic (bridge path)', async () => {
    // Slack/Telegram ship no transcript; they pass `resume` directly. An
    // existing thread must resume even with no recentMessages.
    const rt = new AgentRuntime(backend.port, dataDir);
    const { sink } = makeSink();
    await rt.startRun(sink, {
      conversationId: 'c-bridge-existing',
      content: 'follow up over slack',
      resume: true,
    } as any);
    await new Promise((r) => setTimeout(r, 20));
    expect(runnerStarts).toHaveLength(1);
    expect(runnerStarts[0].resume).toBe(true);
  });

  it('session_in_use on a --session-id spawn → retries once with --resume AND suppresses the error event', async () => {
    // Mirror of the session_missing recovery: the create guess was stale (the
    // session already exists on disk), so the runtime flips to --resume. This
    // is the Slack 2nd-turn / approval "Session ID … is already in use" bug.
    runnerNextBehaviors.push(
      {
        kind: 'error',
        error: 'Reattaching to the existing Claude Code session.',
        errorClass: 'session_in_use',
      },
      { kind: 'done', message: 'resumed output' },
    );

    const rt = new AgentRuntime(backend.port, dataDir);
    const { sink, sent } = makeSink();
    await rt.startRun(sink, {
      conversationId: 'c-inuse',
      content: 'segundo mensaje',
      // No assistant turn shipped → first spawn guesses resume:false.
    } as any);
    await new Promise((r) => setTimeout(r, 50));

    // Two spawns: the failed --session-id, then the recovery --resume.
    expect(runnerStarts).toHaveLength(2);
    expect(runnerStarts[0].resume).toBe(false);
    expect(runnerStarts[1].resume).toBe(true);

    // The transient "already in use" error must never reach the renderer.
    const errorEvents = sent.filter(
      (s) => s.channel.startsWith('agent:event:') && s.payload?.type === 'error',
    );
    expect(errorEvents).toHaveLength(0);
    const doneEvents = sent.filter(
      (s) => s.channel.startsWith('agent:event:') && s.payload?.type === 'done',
    );
    expect(doneEvents.length).toBeGreaterThan(0);
    expect(doneEvents[doneEvents.length - 1].payload.messageContent).toBe('resumed output');
  });

  it('session_in_use surviving the --resume retry → rotates to a fresh session id, re-seeds, and recovers', async () => {
    // Both the create AND the resume hit "in use" → the deterministic id is
    // wedged (orphaned on-disk lock). The runtime rotates to a brand-new UUID
    // (which cannot collide), seeds it from history, and the turn succeeds.
    runnerNextBehaviors.push(
      {
        kind: 'error',
        error: 'Reattaching to the existing Claude Code session.',
        errorClass: 'session_in_use',
      },
      {
        kind: 'error',
        error: 'Reattaching to the existing Claude Code session.',
        errorClass: 'session_in_use',
      },
      { kind: 'done', message: 'rotated recovery' },
    );

    const rt = new AgentRuntime(backend.port, dataDir);
    const { sink, sent } = makeSink();
    await rt.startRun(sink, {
      conversationId: 'c-inuse-rotate',
      content: 'segundo mensaje',
    } as any);
    await new Promise((r) => setTimeout(r, 60));

    // Three spawns: --session-id, --resume, then the rotated --session-id.
    expect(runnerStarts).toHaveLength(3);
    expect(runnerStarts[0].resume).toBe(false);
    expect(runnerStarts[1].resume).toBe(true);
    expect(runnerStarts[2].resume).toBe(false);

    // First two spawns reuse the deterministic id; the third uses a fresh UUID.
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(runnerStarts[0].sessionId).toBe(runnerStarts[1].sessionId);
    expect(runnerStarts[2].sessionId).toMatch(UUID);
    expect(runnerStarts[2].sessionId).not.toBe(runnerStarts[0].sessionId);

    // None of the transient "already in use" errors reach the renderer.
    const errorEvents = sent.filter(
      (s) => s.channel.startsWith('agent:event:') && s.payload?.type === 'error',
    );
    expect(errorEvents).toHaveLength(0);
    const doneEvents = sent.filter(
      (s) => s.channel.startsWith('agent:event:') && s.payload?.type === 'done',
    );
    expect(doneEvents[doneEvents.length - 1].payload.messageContent).toBe('rotated recovery');
  });

  it('session_in_use even after rotation → surfaces the friendly busy message, not the raw CLI string', async () => {
    // Pathological: create, resume, AND the rotated session all report "in
    // use" (a fresh UUID can't really collide — this only models the guard).
    // The user must see a transient message, never "Session ID … is already
    // in use."
    runnerNextBehaviors.push(
      {
        kind: 'error',
        error: 'Reattaching to the existing Claude Code session.',
        errorClass: 'session_in_use',
      },
      {
        kind: 'error',
        error: 'Reattaching to the existing Claude Code session.',
        errorClass: 'session_in_use',
      },
      {
        kind: 'error',
        error: 'Reattaching to the existing Claude Code session.',
        errorClass: 'session_in_use',
      },
    );

    const rt = new AgentRuntime(backend.port, dataDir);
    const { sink, sent } = makeSink();
    await rt.startRun(sink, {
      conversationId: 'c-inuse-stuck',
      content: 'segundo mensaje',
    } as any);
    await new Promise((r) => setTimeout(r, 60));

    expect(runnerStarts).toHaveLength(3); // create, resume, rotated
    const errorEvents = sent.filter(
      (s) => s.channel.startsWith('agent:event:') && s.payload?.type === 'error',
    );
    expect(errorEvents.length).toBeGreaterThan(0);
    expect(errorEvents[errorEvents.length - 1].payload.error).toMatch(/still busy|try again/i);
    expect(errorEvents[errorEvents.length - 1].payload.error).not.toMatch(/already in use/i);
  });

  it('idle_hang on a chat turn → retries once and recovers, suppressing the error event', async () => {
    // A no-tool idle-watchdog kill is transient (a mid-turn stall). The runtime
    // re-spawns once rather than surfacing the raw "produced no output" string.
    runnerNextBehaviors.push(
      {
        kind: 'error',
        error: 'Claude Code produced no output for 90 seconds and was killed.',
        errorClass: 'idle_hang',
      },
      { kind: 'done', message: 'recovered after stall' },
    );

    const rt = new AgentRuntime(backend.port, dataDir);
    const { sink, sent } = makeSink();
    await rt.startRun(sink, { conversationId: 'c-idle', content: 'hola' } as any);
    await new Promise((r) => setTimeout(r, 50));

    expect(runnerStarts).toHaveLength(2); // initial + one idle retry
    const errorEvents = sent.filter(
      (s) => s.channel.startsWith('agent:event:') && s.payload?.type === 'error',
    );
    expect(errorEvents).toHaveLength(0);
    const doneEvents = sent.filter(
      (s) => s.channel.startsWith('agent:event:') && s.payload?.type === 'done',
    );
    expect(doneEvents[doneEvents.length - 1].payload.messageContent).toBe('recovered after stall');
  });

  it('idle_hang twice → surfaces a friendly retry message, never the raw "produced no output" / "Claude Code" string', async () => {
    runnerNextBehaviors.push(
      {
        kind: 'error',
        error: 'Claude Code produced no output for 90 seconds and was killed.',
        errorClass: 'idle_hang',
      },
      {
        kind: 'error',
        error: 'Claude Code produced no output for 90 seconds and was killed.',
        errorClass: 'idle_hang',
      },
    );

    const rt = new AgentRuntime(backend.port, dataDir);
    const { sink, sent } = makeSink();
    await rt.startRun(sink, { conversationId: 'c-idle-stuck', content: 'hola' } as any);
    await new Promise((r) => setTimeout(r, 50));

    expect(runnerStarts).toHaveLength(2); // initial + one retry, then give up
    const errorEvents = sent.filter(
      (s) => s.channel.startsWith('agent:event:') && s.payload?.type === 'error',
    );
    expect(errorEvents.length).toBeGreaterThan(0);
    const surfaced = errorEvents[errorEvents.length - 1].payload.error as string;
    expect(surfaced).not.toMatch(/produced no output|Claude Code/i);
    expect(surfaced).toMatch(/longer than expected|try again/i);
  });

  it('(pre-fix) expert not in index, backend 404 → runtime throws/emits a structured error (does not spawn)', async () => {
    // Backend knows nothing about this expert.
    vi.resetModules();
    const { AgentRuntime: FreshRuntime } = await import('./runtime');

    const rt = new FreshRuntime(backend.port, dataDir);
    const { sink, sent } = makeSink();

    let threw = false;
    try {
      await rt.startRun(sink, {
        conversationId: 'c1',
        content: 'hey',
        expertId: 'totally-missing',
      } as any);
    } catch {
      threw = true;
    }
    await new Promise((r) => setTimeout(r, 20));

    // Pre-fix, it throws synchronously. Post-fix, it may either throw OR emit a
    // structured error event. Either way — it must NOT have spawned.
    expect(runnerStarts).toHaveLength(0);
    if (!threw) {
      const errorEvents = sent.filter(
        (s) => s.channel.startsWith('agent:event:') && s.payload?.type === 'error',
      );
      expect(errorEvents.length).toBeGreaterThan(0);
    }
  });

  // ── Slack/Telegram double-post fix ──────────────────────────────
  // Bug: when a user chats with Cerebro from inside Slack, the agent's reply
  // is already delivered to that channel by SlackStreamSink. With no runtime
  // awareness of the origin, the model also fired send_slack_message at the
  // SAME channel, so the content appeared twice. The fix prepends a
  // <conversation_origin> guardrail to the prompt for messaging surfaces.
  // We can't unit-test that the LLM obeys the instruction, but we CAN lock
  // that the instruction is present in the exact prompt the runner receives
  // (and absent for UI runs, so we never pollute the desktop chat prompt).

  it('Slack source → prompt carries the conversation_origin guardrail with channel + thread_ts', async () => {
    const rt = new AgentRuntime(backend.port, dataDir);
    const { sink } = makeSink();
    await rt.startRun(sink, {
      conversationId: 'c-slack',
      content: 'describe al Experto Creador de Manuales de Ventas',
      source: { kind: 'slack', channel: 'C999', threadTs: '2.000', teamId: 'T1' },
    } as any);
    await new Promise((r) => setTimeout(r, 20));

    expect(runnerStarts).toHaveLength(1);
    const { prompt } = runnerStarts[0];
    expect(prompt).toContain(
      '<conversation_origin service="slack" channel="C999" thread_ts="2.000">',
    );
    // The operative instruction that prevents the double-post.
    expect(prompt).toContain('MUST NOT');
    expect(prompt).toContain('send_slack_message or send_slack_file');
    expect(prompt).toContain('DIFFERENT');
    expect(prompt).toContain('</conversation_origin>');
    // The user's actual message must still be present, after the preamble.
    expect(prompt).toContain('describe al Experto Creador de Manuales de Ventas');
    expect(prompt.indexOf('<conversation_origin')).toBeLessThan(
      prompt.indexOf('describe al Experto'),
    );
  });

  it('Slack DM (no threadTs) → guardrail present without a thread_ts attribute', async () => {
    const rt = new AgentRuntime(backend.port, dataDir);
    const { sink } = makeSink();
    await rt.startRun(sink, {
      conversationId: 'c-slack-dm',
      content: 'hola',
      source: { kind: 'slack', channel: 'D123', threadTs: undefined, teamId: 'T1' },
    } as any);
    await new Promise((r) => setTimeout(r, 20));

    expect(runnerStarts).toHaveLength(1);
    const { prompt } = runnerStarts[0];
    expect(prompt).toContain('<conversation_origin service="slack" channel="D123">');
    expect(prompt).not.toContain('thread_ts=');
  });

  it('Telegram source → prompt carries the telegram guardrail with chat_id', async () => {
    const rt = new AgentRuntime(backend.port, dataDir);
    const { sink } = makeSink();
    await rt.startRun(sink, {
      conversationId: 'c-tg',
      content: 'hi',
      source: { kind: 'telegram', chatId: 42 },
    } as any);
    await new Promise((r) => setTimeout(r, 20));

    expect(runnerStarts).toHaveLength(1);
    const { prompt } = runnerStarts[0];
    expect(prompt).toContain('<conversation_origin service="telegram" chat_id="42">');
    expect(prompt).toContain('send_telegram_message');
    expect(prompt).toContain('MUST NOT');
  });

  it('UI source → NO conversation_origin preamble (desktop reply is not echoed anywhere)', async () => {
    const rt = new AgentRuntime(backend.port, dataDir);
    const { sink } = makeSink();
    await rt.startRun(sink, {
      conversationId: 'c-ui',
      content: 'plain desktop message',
      source: { kind: 'ui' },
    } as any);
    await new Promise((r) => setTimeout(r, 20));

    expect(runnerStarts).toHaveLength(1);
    expect(runnerStarts[0].prompt).not.toContain('<conversation_origin');
  });

  it('no source at all → NO conversation_origin preamble', async () => {
    const rt = new AgentRuntime(backend.port, dataDir);
    const { sink } = makeSink();
    await rt.startRun(sink, {
      conversationId: 'c-nosrc',
      content: 'hey',
    } as any);
    await new Promise((r) => setTimeout(r, 20));

    expect(runnerStarts).toHaveLength(1);
    expect(runnerStarts[0].prompt).not.toContain('<conversation_origin');
  });
});

// ── getLiveTaskIds — liveness signal consumed by the TaskReconciler ─────────
//
// This accessor is the entire foundation of the "task stuck in Por Revisar
// while still running" fix: the health check keys liveness on TASK id (not the
// reportedRunId/sessionId stored in task.run_id, which never matches the
// internal activeRuns key on a resumed run). If this returns the wrong ids the
// reconciler either mis-orphans live tasks or fails to pull prematurely-reviewed
// ones back. We test the contract directly against the activeRuns map so the
// assertions can't be masked by the spawn machinery's timers.
describe('AgentRuntime.getLiveTaskIds', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebro-livetask-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function seed(
    rt: AgentRuntime,
    runs: Array<{ runId: string; conversationId: string; isTaskRun: boolean }>,
  ) {
    const map: Map<string, any> = (rt as any).activeRuns;
    for (const r of runs) {
      map.set(r.runId, {
        runId: r.runId,
        conversationId: r.conversationId,
        expertId: null,
        userContent: '',
        startedAt: 0,
        accumulatedText: '',
        runner: null,
        ptyRunner: null,
        isTaskRun: r.isTaskRun,
      });
    }
  }

  it('returns only the conversationId (== task id) of live TASK runs', () => {
    const rt = new AgentRuntime(0, dataDir);
    seed(rt, [
      { runId: 'r1', conversationId: 'task-1', isTaskRun: true },
      { runId: 'r2', conversationId: 'chat-1', isTaskRun: false },
      { runId: 'r3', conversationId: 'task-2', isTaskRun: true },
    ]);
    expect(rt.getLiveTaskIds().sort()).toEqual(['task-1', 'task-2']);
  });

  it('excludes chat and engine runs (isTaskRun === false)', () => {
    const rt = new AgentRuntime(0, dataDir);
    seed(rt, [
      { runId: 'r1', conversationId: 'chat-1', isTaskRun: false },
      { runId: 'r2', conversationId: 'engine-run:abc', isTaskRun: false },
    ]);
    expect(rt.getLiveTaskIds()).toEqual([]);
  });

  it('returns an empty array when nothing is running', () => {
    const rt = new AgentRuntime(0, dataDir);
    expect(rt.getLiveTaskIds()).toEqual([]);
  });

  it('drops a finalized run as soon as it leaves activeRuns', () => {
    const rt = new AgentRuntime(0, dataDir);
    seed(rt, [{ runId: 'r1', conversationId: 'task-1', isTaskRun: true }]);
    expect(rt.getLiveTaskIds()).toEqual(['task-1']);
    // finalizeRun() deletes the entry; getLiveTaskIds must immediately reflect it
    // (otherwise a genuinely-completed task would be wrongly pulled back to
    // in_progress by Invariant B).
    (rt as any).activeRuns.delete('r1');
    expect(rt.getLiveTaskIds()).toEqual([]);
  });

  it('does not emit a task id for a task run with a missing/empty conversationId', () => {
    const rt = new AgentRuntime(0, dataDir);
    seed(rt, [
      { runId: 'r1', conversationId: '', isTaskRun: true },
      { runId: 'r2', conversationId: 'task-2', isTaskRun: true },
    ]);
    expect(rt.getLiveTaskIds()).toEqual(['task-2']);
  });
});
