/**
 * Pure helpers used by TelegramBridge. Kept here so tests can exercise
 * them without having to mock Electron, node:http, or the engine bus.
 */

import { scrubTokenish } from './api';

/** Split a long string at newline/space boundaries where possible. */
export function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/** Parse a loose comma/space separated list of numeric Telegram IDs. */
export function parseAllowlistRaw(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
}

/**
 * Scrub values that should never reach an outgoing chat message:
 *  - bot tokens (delegated to scrubTokenish — canonical definition)
 *  - absolute paths under the data dir
 *  - sk-* looking strings (generic API keys)
 */
export function redactForChat(text: string, dataDir: string): string {
  let out = scrubTokenish(text);
  const escaped = dataDir.replace(/[\\/]/g, '[\\\\/]');
  out = out.replace(new RegExp(escaped + '[^\\s"\']*', 'g'), '<path>');
  out = out.replace(/sk-[A-Za-z0-9_-]{20,}/g, '<key>');
  return out;
}

/**
 * Sliding window rate limiter. Used for: unknown-user replies,
 * authorised-user message caps, proactive routine messages.
 *
 * Caps total keys to prevent unbounded growth if many strangers probe
 * the bot: once the cap is hit, the key with the oldest activity is
 * dropped.
 */
export class SlidingWindowLimiter {
  private buckets = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys: number = 10_000,
  ) {}

  allow(key: string, now: number = Date.now()): boolean {
    const bucket = (this.buckets.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (bucket.length >= this.max) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.push(now);
    this.buckets.set(key, bucket);

    if (this.buckets.size > this.maxKeys) {
      // Drop the oldest-inserted key. Map preserves insertion order, so
      // keys().next() is the first-seen key.
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined && oldest !== key) {
        this.buckets.delete(oldest);
      }
    }
    return true;
  }
}

/** Parse a callback_query.data string for an approval decision. */
export function parseApprovalCallback(data: string): { action: 'approve' | 'deny'; approvalId: string } | null {
  const m = data.match(/^(approve|deny):(.+)$/);
  if (!m) return null;
  return { action: m[1] as 'approve' | 'deny', approvalId: m[2] };
}

// ── Telegram trigger routing ─────────────────────────────────────

import type { DAGDefinition } from '../engine/dag/types';

/** Subset of the CanvasDefinition we need at routine-trigger parse time. */
interface CanvasDagJson extends DAGDefinition {
  trigger?: {
    triggerType?: string;
    config?: Record<string, unknown>;
  };
}

export type TelegramFilterType = 'none' | 'keyword' | 'prefix' | 'regex';

export interface TelegramTriggerConfig {
  /** Telegram chat id to match — '*' matches any allowlisted chat. */
  chat_id: string;
  filter_type?: TelegramFilterType;
  filter_value?: string;
}

export interface TelegramTriggerRoutine {
  id: string;
  name: string;
  dag: DAGDefinition;
  trigger: TelegramTriggerConfig;
}

/** A loose backend Routine row — only the fields we care about for triggers. */
export interface BackendRoutineRecord {
  id: string;
  name: string;
  is_enabled: boolean;
  trigger_type: string;
  dag_json: string | null;
}

/**
 * Pull the trigger config out of a routine's dag_json. The Telegram trigger
 * lives on `CanvasDefinition.trigger` (the visual trigger node), not in
 * `steps`, so that's where we read it from. Returns null if the routine
 * doesn't have a usable telegram trigger.
 */
export function parseTelegramTriggerRoutine(record: BackendRoutineRecord): TelegramTriggerRoutine | null {
  if (!record.dag_json) return null;
  let dag: CanvasDagJson;
  try {
    dag = JSON.parse(record.dag_json) as CanvasDagJson;
  } catch {
    return null;
  }
  if (dag.trigger?.triggerType !== 'trigger_telegram_message') return null;
  const cfg = dag.trigger?.config ?? {};
  const chat_id = typeof cfg.chat_id === 'string' ? cfg.chat_id.trim() : '';
  if (!chat_id) return null;
  const rawFilterType = typeof cfg.filter_type === 'string' ? cfg.filter_type : 'none';
  const filter_type: TelegramFilterType = (
    rawFilterType === 'keyword' || rawFilterType === 'prefix' || rawFilterType === 'regex'
      ? rawFilterType : 'none'
  );
  const filter_value = typeof cfg.filter_value === 'string' ? cfg.filter_value : '';
  // The trigger lives on `dag.trigger`, never as a step, so the runtime DAG
  // is just `dag.steps` — no need to filter anything out.
  const runtimeDag: DAGDefinition = { steps: dag.steps ?? [] };
  return {
    id: record.id,
    name: record.name,
    dag: runtimeDag,
    trigger: { chat_id, filter_type, filter_value },
  };
}

/** True if `text` satisfies a routine's filter. Empty filter_value with a
 *  non-'none' type means "match anything" (consistent with form ergonomics). */
export function matchesTelegramFilter(
  text: string,
  filterType: TelegramFilterType | undefined,
  filterValue: string | undefined,
): boolean {
  const type = filterType ?? 'none';
  const value = (filterValue ?? '').trim();
  if (type === 'none' || value === '') return true;
  const haystack = text ?? '';
  if (type === 'keyword') {
    return new RegExp(`\\b${escapeRegExp(value)}\\b`, 'i').test(haystack);
  }
  if (type === 'prefix') {
    return haystack.toLowerCase().startsWith(value.toLowerCase());
  }
  if (type === 'regex') {
    try {
      return new RegExp(value, 'i').test(haystack);
    } catch {
      return false; // bad pattern → no match (don't crash the bridge)
    }
  }
  return false;
}

/** Filter a list of pre-parsed telegram-trigger routines against an inbound message. */
export function matchRoutineTriggers(
  routines: TelegramTriggerRoutine[],
  chatId: string,
  text: string,
): TelegramTriggerRoutine[] {
  const matched: TelegramTriggerRoutine[] = [];
  for (const r of routines) {
    const target = r.trigger.chat_id;
    const chatMatches = target === '*' || target === chatId;
    if (!chatMatches) continue;
    if (!matchesTelegramFilter(text, r.trigger.filter_type, r.trigger.filter_value)) continue;
    matched.push(r);
  }
  return matched;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
