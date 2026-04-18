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
  class FakeClaudeCodeRunner extends EE {
    start(opts: StartArgs) {
      // Snapshot at spawn time: does the agent's .md file exist right now?
      const mdPath = pathMod.join(opts.cwd, '.claude', 'agents', `${opts.agentName}.md`);
      runnerStarts.push({
        ...opts,
        _cwdAtStart: opts.cwd,
        _agentFileExistedAtStart: fsMod.existsSync(mdPath),
      });
      queueMicrotask(() => {
        if (runnerShouldError.value) {
          this.emit('event', { type: 'error', runId: opts.runId, error: runnerShouldError.value });
          this.emit('error', runnerShouldError.value);
        } else {
          this.emit('event', { type: 'done', runId: opts.runId, messageContent: '' });
          this.emit('done', '');
        }
      });
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
    FakeClaudeCodeRunner,
    FakeTaskPtyRunner,
    FakeTerminalBufferStore,
  };
});

const { runnerStarts, runnerShouldError } = h;

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
});
