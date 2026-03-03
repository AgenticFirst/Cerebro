import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createExpertStepAction } from '../actions/expert-step';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext, ExecutionEvent } from '../actions/types';
import type { RendererAgentEvent } from '../../agents/types';

// ── Mock factories ──────────────────────────────────────────────

/**
 * Creates a mock WebContents with an IPC event emitter.
 * The mock emits events on the agent channel so expert_step can collect them.
 */
function createMockWebContents() {
  const ipc = new EventEmitter();
  return {
    ipc,
    isDestroyed: () => false,
    send: vi.fn(),
  };
}

/**
 * Creates a mock AgentRuntime.startRun that:
 * 1. Returns a fake runId
 * 2. Asynchronously emits the provided agent events on the IPC channel
 */
function createMockRuntime(
  webContents: ReturnType<typeof createMockWebContents>,
  events: RendererAgentEvent[],
) {
  const fakeRunId = 'agent-run-abc123';

  return {
    startRun: vi.fn(async () => {
      // Emit events on next tick so collectAgentResults has time to subscribe
      setImmediate(() => {
        const channel = `agent:event:${fakeRunId}`;
        for (const event of events) {
          webContents.ipc.emit(channel, {}, event);
        }
      });
      return fakeRunId;
    }),
  };
}

function makeContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    runId: 'engine-run-1',
    stepId: 'step-1',
    backendPort: 9999,
    signal: new AbortController().signal,
    log: vi.fn(),
    emitEvent: vi.fn(),
    resolveModel: async () => null,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe('expert_step action', () => {
  it('delegates to AgentRuntime.startRun with correct request', async () => {
    const webContents = createMockWebContents();
    const runtime = createMockRuntime(webContents, [
      { type: 'done', runId: 'agent-run-abc123', messageContent: 'Done' },
    ]);

    const action = createExpertStepAction({
      agentRuntime: runtime as any,
      webContents: webContents as any,
    });

    const context = makeContext();
    await action.execute({
      params: { prompt: 'Summarize the data', expertId: 'expert-42' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context,
    });

    expect(runtime.startRun).toHaveBeenCalledWith(webContents, {
      conversationId: 'engine-run:engine-run-1',
      content: 'Summarize the data',
      expertId: 'expert-42',
    });
  });

  it('prepends additionalContext to prompt', async () => {
    const webContents = createMockWebContents();
    const runtime = createMockRuntime(webContents, [
      { type: 'done', runId: 'agent-run-abc123', messageContent: 'ok' },
    ]);

    const action = createExpertStepAction({
      agentRuntime: runtime as any,
      webContents: webContents as any,
    });

    await action.execute({
      params: { prompt: 'Do the thing', additionalContext: 'Context here' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    expect(runtime.startRun).toHaveBeenCalledWith(
      webContents,
      expect.objectContaining({ content: 'Context here\n\nDo the thing' }),
    );
  });

  it('collects response and tools used from agent events', async () => {
    const webContents = createMockWebContents();
    const runtime = createMockRuntime(webContents, [
      { type: 'run_start', runId: 'agent-run-abc123' },
      { type: 'turn_start', turn: 1 },
      { type: 'tool_start', toolCallId: 'tc1', toolName: 'web_search', args: {} },
      { type: 'tool_end', toolCallId: 'tc1', toolName: 'web_search', result: 'results', isError: false },
      { type: 'text_delta', delta: 'The answer is 42' },
      { type: 'done', runId: 'agent-run-abc123', messageContent: 'The answer is 42' },
    ]);

    const action = createExpertStepAction({
      agentRuntime: runtime as any,
      webContents: webContents as any,
    });

    const output = await action.execute({
      params: { prompt: 'test' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    expect(output.data.response).toBe('The answer is 42');
    expect(output.data.toolsUsed).toEqual(['web_search']);
    expect(output.data.turns).toBe(1);
    expect(output.data.agentRunId).toBe('agent-run-abc123');
  });

  it('translates agent text_delta to action_text_delta engine event', async () => {
    const webContents = createMockWebContents();
    const runtime = createMockRuntime(webContents, [
      { type: 'text_delta', delta: 'hello' },
      { type: 'done', runId: 'agent-run-abc123', messageContent: 'hello' },
    ]);

    const action = createExpertStepAction({
      agentRuntime: runtime as any,
      webContents: webContents as any,
    });

    const emitEvent = vi.fn();
    await action.execute({
      params: { prompt: 'test' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext({ emitEvent }),
    });

    const textEvents = emitEvent.mock.calls
      .map(([e]: [ExecutionEvent]) => e)
      .filter((e) => e.type === 'action_text_delta');
    expect(textEvents).toEqual([
      { type: 'action_text_delta', stepId: 'step-1', delta: 'hello' },
    ]);
  });

  it('translates agent tool_start/tool_end to engine events', async () => {
    const webContents = createMockWebContents();
    const runtime = createMockRuntime(webContents, [
      { type: 'tool_start', toolCallId: 'tc1', toolName: 'web_search', args: { query: 'test' } },
      { type: 'tool_end', toolCallId: 'tc1', toolName: 'web_search', result: '{}', isError: false },
      { type: 'done', runId: 'agent-run-abc123', messageContent: 'done' },
    ]);

    const action = createExpertStepAction({
      agentRuntime: runtime as any,
      webContents: webContents as any,
    });

    const emitEvent = vi.fn();
    await action.execute({
      params: { prompt: 'test' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext({ emitEvent }),
    });

    const toolEvents = emitEvent.mock.calls
      .map(([e]: [ExecutionEvent]) => e)
      .filter((e) => e.type === 'action_tool_start' || e.type === 'action_tool_end');

    expect(toolEvents[0]).toEqual({
      type: 'action_tool_start',
      stepId: 'step-1',
      toolCallId: 'tc1',
      toolName: 'web_search',
      args: { query: 'test' },
    });
    expect(toolEvents[1]).toEqual({
      type: 'action_tool_end',
      stepId: 'step-1',
      toolCallId: 'tc1',
      toolName: 'web_search',
      result: '{}',
      isError: false,
    });
  });

  it('does not translate run_start or turn_start to engine events', async () => {
    const webContents = createMockWebContents();
    const runtime = createMockRuntime(webContents, [
      { type: 'run_start', runId: 'agent-run-abc123' },
      { type: 'turn_start', turn: 1 },
      { type: 'done', runId: 'agent-run-abc123', messageContent: 'ok' },
    ]);

    const action = createExpertStepAction({
      agentRuntime: runtime as any,
      webContents: webContents as any,
    });

    const emitEvent = vi.fn();
    await action.execute({
      params: { prompt: 'test' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext({ emitEvent }),
    });

    // run_start and turn_start should NOT produce engine events
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('rejects when agent emits error event', async () => {
    const webContents = createMockWebContents();
    const runtime = createMockRuntime(webContents, [
      { type: 'error', runId: 'agent-run-abc123', error: 'Model overloaded' },
    ]);

    const action = createExpertStepAction({
      agentRuntime: runtime as any,
      webContents: webContents as any,
    });

    await expect(
      action.execute({
        params: { prompt: 'test' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('Model overloaded');
  });

  it('deduplicates tools used across multiple calls', async () => {
    const webContents = createMockWebContents();
    const runtime = createMockRuntime(webContents, [
      { type: 'tool_start', toolCallId: 'tc1', toolName: 'web_search', args: {} },
      { type: 'tool_end', toolCallId: 'tc1', toolName: 'web_search', result: '', isError: false },
      { type: 'tool_start', toolCallId: 'tc2', toolName: 'web_search', args: {} },
      { type: 'tool_end', toolCallId: 'tc2', toolName: 'web_search', result: '', isError: false },
      { type: 'tool_start', toolCallId: 'tc3', toolName: 'memory_recall', args: {} },
      { type: 'tool_end', toolCallId: 'tc3', toolName: 'memory_recall', result: '', isError: false },
      { type: 'done', runId: 'agent-run-abc123', messageContent: 'done' },
    ]);

    const action = createExpertStepAction({
      agentRuntime: runtime as any,
      webContents: webContents as any,
    });

    const output = await action.execute({
      params: { prompt: 'test' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    expect(output.data.toolsUsed).toEqual(['web_search', 'memory_recall']);
  });
});
