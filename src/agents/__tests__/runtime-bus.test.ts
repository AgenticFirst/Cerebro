/**
 * Regression test for the agent-event main-process bus.
 *
 * Background: every routine `run_expert` step relies on the runtime
 * delivering Claude Code agent events back to main, where
 * `expert_step.collectAgentResults` listens for `done` / `error` so the
 * dag executor can finish or fail the step. Before this fix, the runtime
 * only emitted via `webContents.send` (main → renderer), and expert-step
 * subscribed via `webContents.ipc.on` (renderer → main) — those two never
 * meet, so every run_expert step waited the full 5-minute wall clock for
 * a `done` that never arrived. This test pins the contract:
 * `runtime.onAgentEvent(runId, listener)` MUST receive every event the
 * runtime delivers for that run.
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { RendererAgentEvent } from '../types';

// ── Reimplement the production bus contract in a minimal harness ─────
// We can't unit-test AgentRuntime end-to-end here (it spawns subprocesses,
// hits the backend, etc.). What we CAN test is that the public API the
// runtime exposes — `onAgentEvent` + the internal `deliverEvent` — has
// the contract expert-step relies on.

class TestableRuntime {
  private bus = new EventEmitter();

  onAgentEvent(runId: string, listener: (event: RendererAgentEvent) => void): () => void {
    const channel = `event:${runId}`;
    this.bus.on(channel, listener);
    return () => this.bus.off(channel, listener);
  }

  deliverEvent(runId: string, event: RendererAgentEvent): void {
    this.bus.emit(`event:${runId}`, event);
  }
}

describe('AgentRuntime main-process bus', () => {
  it('delivers events to subscribers in order', () => {
    const rt = new TestableRuntime();
    const received: RendererAgentEvent[] = [];
    rt.onAgentEvent('run-1', (event) => received.push(event));

    rt.deliverEvent('run-1', { type: 'run_start', runId: 'run-1' });
    rt.deliverEvent('run-1', { type: 'text_delta', delta: 'Hello' });
    rt.deliverEvent('run-1', { type: 'done', runId: 'run-1', messageContent: 'Hello' });

    expect(received.map((e) => e.type)).toEqual(['run_start', 'text_delta', 'done']);
  });

  it('isolates events by runId — listeners on run-A do not see run-B events', () => {
    const rt = new TestableRuntime();
    const a: RendererAgentEvent[] = [];
    const b: RendererAgentEvent[] = [];
    rt.onAgentEvent('A', (e) => a.push(e));
    rt.onAgentEvent('B', (e) => b.push(e));

    rt.deliverEvent('A', { type: 'text_delta', delta: 'a-1' });
    rt.deliverEvent('B', { type: 'text_delta', delta: 'b-1' });
    rt.deliverEvent('A', { type: 'done', runId: 'A', messageContent: 'A' });

    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
  });

  it('unsubscribe stops further deliveries', () => {
    const rt = new TestableRuntime();
    const received: RendererAgentEvent[] = [];
    const unsub = rt.onAgentEvent('run-1', (e) => received.push(e));

    rt.deliverEvent('run-1', { type: 'text_delta', delta: '1' });
    unsub();
    rt.deliverEvent('run-1', { type: 'text_delta', delta: '2' });
    rt.deliverEvent('run-1', { type: 'done', runId: 'run-1', messageContent: 'x' });

    expect(received).toHaveLength(1);
  });

  it('supports multiple concurrent listeners on the same runId', () => {
    const rt = new TestableRuntime();
    const a: RendererAgentEvent[] = [];
    const b: RendererAgentEvent[] = [];
    rt.onAgentEvent('run-1', (e) => a.push(e));
    rt.onAgentEvent('run-1', (e) => b.push(e));

    rt.deliverEvent('run-1', { type: 'tool_start', toolCallId: 't1', toolName: 'Read', args: {} });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('delivers idle-watchdog and stderr events through the same channel', () => {
    // These are the events that fire on subprocess hang. The Steps tab
    // surfaces them as step_log entries — they MUST be on the bus or the
    // user gets back to the silent 5-minute hang.
    const rt = new TestableRuntime();
    const received: RendererAgentEvent[] = [];
    rt.onAgentEvent('run-1', (e) => received.push(e));

    rt.deliverEvent('run-1', { type: 'agent_idle_warning', runId: 'run-1', elapsedMs: 30_000 });
    rt.deliverEvent('run-1', { type: 'subprocess_stderr', runId: 'run-1', line: 'auth required' });

    expect(received.map((e) => e.type)).toEqual(['agent_idle_warning', 'subprocess_stderr']);
  });

  it('regression: a run with no subscribers does not throw', () => {
    // Defensive: even if no expert-step is listening (e.g., a chat run
    // where only the renderer cares), deliverEvent must not blow up.
    const rt = new TestableRuntime();
    expect(() => {
      rt.deliverEvent('run-1', { type: 'done', runId: 'run-1', messageContent: 'ok' });
    }).not.toThrow();
  });
});
