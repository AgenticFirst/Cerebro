/**
 * Parse Codex `exec --json` JSONL output into Cerebro's `RendererAgentEvent`
 * union — the same events `ClaudeCodeRunner` emits — so the renderer and the
 * Activity panel never branch on engine id.
 *
 * Ported from obelisk's `src/main/runners/codex-stream-json.ts` (a proven
 * dual-engine implementation), adapted from its internal `AgentEvent` to
 * Cerebro's `RendererAgentEvent` and extended with Cerebro's error
 * classification + thread-id capture for session resume.
 *
 * Codex's event vocabulary (one JSON object per line):
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.started","item":{"id":"item_N","type":"<kind>",...}}
 *   {"type":"item.completed","item":{"id":"item_N","type":"<kind>",...}}
 *   {"type":"turn.completed","usage":{...}}
 *   {"type":"turn.failed","error":{...}}  |  {"type":"error","message":"..."}
 *
 * Item kinds:
 *   - agent_message (text)          → text_delta (accumulated into the reply)
 *   - reasoning     (text)          → system/reasoning (NOT part of the reply)
 *   - command_execution/local_shell → Bash tool_start/tool_end
 *   - file_change / patch           → Write (all adds) / Edit tool_start/tool_end
 *   - mcp_tool_call                 → tool with item-supplied name
 *   - web_search                    → WebSearch
 *   - web_fetch / browse            → WebFetch
 *   - todo_list                     → TodoWrite
 *   - sub_agent                     → Task
 * Anything unrecognized becomes a `system` event so it's never lost.
 */

import type { RendererAgentEvent } from '../../agents/types';
import type { RunnerErrorClass } from '../types';

export interface CodexParseResult {
  events: RendererAgentEvent[];
}

export class CodexEventParser {
  private accumulatedText = '';
  private threadId: string | null = null;
  /** Tool ids we've already emitted a `tool_start` for (avoid double-open). */
  private readonly startedToolIds = new Set<string>();
  /** Set when an `error` / `turn.failed` event is seen. */
  private failure: { message: string; errorClass: RunnerErrorClass } | null = null;

  getThreadId(): string | null {
    return this.threadId;
  }

  getAccumulatedText(): string {
    return this.accumulatedText;
  }

  getFailure(): { message: string; errorClass: RunnerErrorClass } | null {
    return this.failure;
  }

  /** Feed one stdout line (newline already stripped). Returns events to emit. */
  feedLine(line: string): CodexParseResult {
    const trimmed = line.trim();
    if (!trimmed) return { events: [] };
    let obj: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object') return { events: [] };
      obj = parsed as Record<string, unknown>;
    } catch {
      // Non-JSON line (e.g. codex's "Reading additional input from stdin…"
      // banner). Surface as a system row so it's never silently dropped.
      return { events: [{ type: 'system', message: trimmed, subtype: 'stdout' }] };
    }
    return { events: this.consume(obj) };
  }

  private consume(obj: Record<string, unknown>): RendererAgentEvent[] {
    const type = str(obj, 'type');

    if (type === 'thread.started') {
      const id = str(obj, 'thread_id');
      if (id) this.threadId = id;
      return [{ type: 'system', message: 'session started', subtype: 'init' }];
    }

    if (type === 'turn.completed') {
      let message = 'Turn completed';
      const usage = obj['usage'] as Record<string, unknown> | undefined;
      if (usage) {
        const total =
          (num(usage, 'input_tokens') ?? 0) +
          (num(usage, 'output_tokens') ?? 0) +
          (num(usage, 'reasoning_output_tokens') ?? 0);
        if (total > 0) message = `Turn completed (${total.toLocaleString()} tokens)`;
      }
      return [{ type: 'system', message, subtype: 'result' }];
    }

    if (type === 'error' || type === 'turn.failed') {
      const message = extractErrorMessage(obj);
      this.failure = { message, errorClass: classifyCodexError(message) };
      // The runner reads getFailure() in its close handler and emits the
      // terminal `error` event — don't emit one here (avoids double-fire).
      return [];
    }

    if (type === 'item.started') {
      const item = obj['item'] as Record<string, unknown> | undefined;
      if (!item) return [];
      const ev = this.toolStart(item);
      return ev ? [ev] : [];
    }

    if (type === 'item.completed') {
      const item = obj['item'] as Record<string, unknown> | undefined;
      if (!item) return [];
      const itemType = str(item, 'type');

      if (itemType === 'agent_message') {
        const text = str(item, 'text') ?? str(item, 'content');
        if (text) {
          this.accumulatedText += text;
          return [{ type: 'text_delta', delta: text }];
        }
        return [];
      }
      if (itemType === 'reasoning') {
        const text = str(item, 'text') ?? str(item, 'content');
        // Reasoning is the model's private chain-of-thought — surface it as a
        // system row (drives the "thinking" indicator) but never fold it into
        // the visible reply.
        return text ? [{ type: 'system', message: clip(text, 200), subtype: 'reasoning' }] : [];
      }

      // Tool-shaped item. `item.started` may have been skipped (codex reports
      // the whole step in one shot), so emit a tool_start if we haven't yet,
      // then the tool_end.
      const out: RendererAgentEvent[] = [];
      const id = str(item, 'id') ?? '';
      if (!this.startedToolIds.has(id)) {
        const start = this.toolStart(item);
        if (start) out.push(start);
      }
      out.push(this.toolEnd(item));
      return out;
    }

    // turn.started and anything else — keep as a system row, never rendered as
    // the reply, never lost.
    if (typeof type === 'string') {
      return [{ type: 'system', message: type, subtype: type }];
    }
    return [];
  }

  private toolStart(item: Record<string, unknown>): RendererAgentEvent | null {
    const itemType = str(item, 'type') ?? 'tool';
    if (itemType === 'agent_message' || itemType === 'reasoning') return null;
    const id = str(item, 'id') ?? '';
    this.startedToolIds.add(id);
    const { name, input } = mapItemToTool(itemType, item);
    return { type: 'tool_start', toolCallId: id, toolName: name, args: input };
  }

  private toolEnd(item: Record<string, unknown>): RendererAgentEvent {
    const id = str(item, 'id') ?? '';
    const itemType = str(item, 'type') ?? 'tool';
    const { name } = mapItemToTool(itemType, item);
    const { content, ok } = mapItemToToolResult(itemType, item);
    return {
      type: 'tool_end',
      toolCallId: id,
      toolName: name,
      result: content.slice(0, 2000),
      isError: !ok,
    };
  }
}

// ── Item → tool mapping (ported from obelisk) ────────────────────

function mapItemToTool(
  itemType: string,
  item: Record<string, unknown>,
): { name: string; input: unknown } {
  switch (itemType) {
    case 'command_execution':
    case 'local_shell': {
      return { name: 'Bash', input: { command: str(item, 'command') ?? '' } };
    }
    case 'file_change':
    case 'patch': {
      const changes = Array.isArray(item['changes']) ? (item['changes'] as unknown[]) : [];
      const first = changes[0] as Record<string, unknown> | undefined;
      const path = first ? str(first, 'path') : undefined;
      const allAdds =
        changes.length > 0 &&
        changes.every(
          (c) => c != null && typeof c === 'object' && (c as Record<string, unknown>)['kind'] === 'add',
        );
      return {
        name: allAdds ? 'Write' : 'Edit',
        input: { file_path: path ?? '', changes },
      };
    }
    case 'mcp_tool_call': {
      const name =
        str(item, 'tool_name') ?? str(item, 'name') ?? str(item, 'server') ?? 'mcp_tool';
      return { name, input: item['arguments'] ?? item['input'] ?? item['args'] ?? {} };
    }
    case 'web_search':
      return { name: 'WebSearch', input: { query: str(item, 'query') ?? str(item, 'q') ?? '' } };
    case 'web_fetch':
    case 'browse':
      return { name: 'WebFetch', input: { url: str(item, 'url') ?? '' } };
    case 'todo_list':
      return { name: 'TodoWrite', input: { items: item['items'] ?? item['tasks'] ?? [] } };
    case 'sub_agent':
      return {
        name: 'Task',
        input: { description: str(item, 'description') ?? str(item, 'task') ?? 'sub-agent' },
      };
    default:
      return { name: itemType || 'tool', input: item };
  }
}

function mapItemToToolResult(
  itemType: string,
  item: Record<string, unknown>,
): { content: string; ok: boolean } {
  switch (itemType) {
    case 'command_execution':
    case 'local_shell': {
      const output = str(item, 'aggregated_output') ?? str(item, 'output') ?? '';
      const exitCode = num(item, 'exit_code');
      return { content: output, ok: exitCode === undefined ? true : exitCode === 0 };
    }
    case 'file_change':
    case 'patch': {
      const changes = Array.isArray(item['changes']) ? (item['changes'] as unknown[]) : [];
      const summary = changes
        .map((c) => {
          if (!c || typeof c !== 'object') return '';
          const r = c as Record<string, unknown>;
          return `${str(r, 'kind') ?? 'change'} ${str(r, 'path') ?? ''}`.trim();
        })
        .filter(Boolean)
        .join('\n');
      return { content: summary, ok: str(item, 'status') !== 'failed' };
    }
    case 'mcp_tool_call': {
      const result = str(item, 'result') ?? str(item, 'output') ?? safeStringify(item['result'] ?? item['output']);
      return { content: result, ok: str(item, 'status') !== 'failed' };
    }
    case 'web_search':
    case 'web_fetch':
    case 'browse':
      return { content: str(item, 'result') ?? str(item, 'summary') ?? '', ok: true };
    case 'todo_list':
    case 'sub_agent':
      return { content: safeStringify(item), ok: str(item, 'status') !== 'failed' };
    default:
      return { content: safeStringify(item), ok: str(item, 'status') !== 'failed' };
  }
}

// ── Error classification ─────────────────────────────────────────

export function classifyCodexError(message: string): RunnerErrorClass {
  const lower = message.toLowerCase();
  if (/not\s+logged\s+in|not\s+authenticated|unauthori[sz]ed|401|run\s+codex\s+login|token\s+(?:expired|invalid|revoked)/.test(lower)) {
    return 'auth';
  }
  if (/rate\s*limit|overload|usage\s*limit|quota|429|503/.test(lower)) return 'overload';
  if (/context|token\s+limit|too\s+(?:long|large)|max(?:imum)?\s+(?:context|tokens)/.test(lower)) {
    return 'context';
  }
  if (/no\s+(?:such\s+)?(?:session|thread|conversation)|session\s+not\s+found|unknown\s+(?:session|thread)/.test(lower)) {
    return 'session_missing';
  }
  if (/max\s*turns?/.test(lower)) return 'max_turns';
  return 'unknown';
}

function extractErrorMessage(obj: Record<string, unknown>): string {
  const direct = str(obj, 'message') ?? str(obj, 'error');
  if (direct) return direct;
  const err = obj['error'];
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    return str(e, 'message') ?? str(e, 'code') ?? safeStringify(err);
  }
  return safeStringify(obj);
}

// ── helpers ──────────────────────────────────────────────────────

function str(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function num(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === 'number' ? v : undefined;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

function safeStringify(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
