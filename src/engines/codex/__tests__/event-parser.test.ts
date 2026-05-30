import { describe, it, expect } from 'vitest';
import { CodexEventParser, classifyCodexError } from '../event-parser';
import type { RendererAgentEvent } from '../../../agents/types';

/**
 * Ported from obelisk's `test/main/codex-stream-json.test.ts`, adapted to
 * Cerebro's RendererAgentEvent union. These lock the Codex JSONL → event
 * mapping — the riskiest part of the integration.
 */

function feed(parser: CodexEventParser, lines: object[]): RendererAgentEvent[] {
  const out: RendererAgentEvent[] = [];
  for (const obj of lines) out.push(...parser.feedLine(JSON.stringify(obj)).events);
  return out;
}

describe('CodexEventParser', () => {
  it('captures the thread id from thread.started and emits an init system event', () => {
    const p = new CodexEventParser();
    const events = feed(p, [{ type: 'thread.started', thread_id: 'th_abc123' }]);
    expect(p.getThreadId()).toBe('th_abc123');
    expect(events).toEqual([{ type: 'system', message: 'session started', subtype: 'init' }]);
  });

  it('maps agent_message to a text_delta and accumulates the reply', () => {
    const p = new CodexEventParser();
    const events = feed(p, [
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'Hello there.' } },
    ]);
    expect(events).toEqual([{ type: 'text_delta', delta: 'Hello there.' }]);
    expect(p.getAccumulatedText()).toBe('Hello there.');
  });

  it('keeps reasoning out of the reply (system event, not accumulated)', () => {
    const p = new CodexEventParser();
    const events = feed(p, [
      { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'thinking...' } },
    ]);
    expect(events[0].type).toBe('system');
    expect((events[0] as { subtype?: string }).subtype).toBe('reasoning');
    expect(p.getAccumulatedText()).toBe('');
  });

  it('maps command_execution to a Bash tool_start + tool_end pair', () => {
    const p = new CodexEventParser();
    const start = feed(p, [
      { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls -la' } },
    ]);
    expect(start).toEqual([
      { type: 'tool_start', toolCallId: 'c1', toolName: 'Bash', args: { command: 'ls -la' } },
    ]);
    const end = feed(p, [
      {
        type: 'item.completed',
        item: { id: 'c1', type: 'command_execution', command: 'ls -la', aggregated_output: 'file.txt', exit_code: 0 },
      },
    ]);
    // item.started already opened the tool — only a tool_end should follow.
    expect(end).toEqual([
      { type: 'tool_end', toolCallId: 'c1', toolName: 'Bash', result: 'file.txt', isError: false },
    ]);
  });

  it('emits both tool_start and tool_end when item.started was skipped', () => {
    const p = new CodexEventParser();
    const events = feed(p, [
      {
        type: 'item.completed',
        item: { id: 'c9', type: 'command_execution', command: 'pwd', aggregated_output: '/tmp', exit_code: 0 },
      },
    ]);
    expect(events.map((e) => e.type)).toEqual(['tool_start', 'tool_end']);
  });

  it('flags a non-zero exit_code as an error result', () => {
    const p = new CodexEventParser();
    const events = feed(p, [
      {
        type: 'item.completed',
        item: { id: 'c2', type: 'command_execution', command: 'false', output: 'boom', exit_code: 1 },
      },
    ]);
    const end = events.find((e) => e.type === 'tool_end') as Extract<RendererAgentEvent, { type: 'tool_end' }>;
    expect(end.isError).toBe(true);
  });

  it('maps file_change to Write when every change is an add, else Edit', () => {
    const adds = new CodexEventParser();
    const writeEvents = feed(adds, [
      {
        type: 'item.completed',
        item: { id: 'f1', type: 'file_change', changes: [{ kind: 'add', path: 'a.ts' }] },
      },
    ]);
    expect((writeEvents[0] as { toolName: string }).toolName).toBe('Write');

    const edits = new CodexEventParser();
    const editEvents = feed(edits, [
      {
        type: 'item.completed',
        item: { id: 'f2', type: 'file_change', changes: [{ kind: 'modify', path: 'b.ts' }] },
      },
    ]);
    expect((editEvents[0] as { toolName: string }).toolName).toBe('Edit');
  });

  it('records a failure (with classification) on a turn.failed event', () => {
    const p = new CodexEventParser();
    const events = feed(p, [{ type: 'turn.failed', error: { message: 'usage limit reached' } }]);
    expect(events).toEqual([]); // the runner emits the terminal error, not the parser
    expect(p.getFailure()).toEqual({ message: 'usage limit reached', errorClass: 'overload' });
  });

  it('records an auth failure on an error event', () => {
    const p = new CodexEventParser();
    feed(p, [{ type: 'error', message: 'You are not logged in. Run codex login.' }]);
    expect(p.getFailure()?.errorClass).toBe('auth');
  });

  it('forwards a non-JSON banner line as a stdout system event', () => {
    const p = new CodexEventParser();
    const events = p.feedLine('Reading additional input from stdin...').events;
    expect(events).toEqual([
      { type: 'system', message: 'Reading additional input from stdin...', subtype: 'stdout' },
    ]);
  });

  it('preserves an unknown item kind as a tool with its raw type name', () => {
    const p = new CodexEventParser();
    const events = feed(p, [
      { type: 'item.completed', item: { id: 'x1', type: 'mystery_kind', foo: 'bar' } },
    ]);
    const start = events.find((e) => e.type === 'tool_start') as Extract<RendererAgentEvent, { type: 'tool_start' }>;
    expect(start.toolName).toBe('mystery_kind');
  });

  it('reports turn.completed token usage as a result system event', () => {
    const p = new CodexEventParser();
    const events = feed(p, [
      { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } },
    ]);
    expect(events[0]).toMatchObject({ type: 'system', subtype: 'result' });
    expect((events[0] as { message: string }).message).toContain('150');
  });
});

describe('classifyCodexError', () => {
  it('classifies known error shapes', () => {
    expect(classifyCodexError('401 unauthorized')).toBe('auth');
    expect(classifyCodexError('rate limit exceeded')).toBe('overload');
    expect(classifyCodexError('maximum context length')).toBe('context');
    expect(classifyCodexError('no such session')).toBe('session_missing');
    expect(classifyCodexError('something weird happened')).toBe('unknown');
  });
});
