/**
 * Pure helpers used by SlackBridge. Kept here so tests can exercise them
 * without having to mock Bolt, node:http, or the engine bus.
 */

import { scrubTokenish } from './api';
import type { SlackConversationEntry } from './types';
import type { DAGDefinition } from '../engine/dag/types';

// ── Conversation keying ───────────────────────────────────────────

export type SlackSurfaceKind = 'dm' | 'thread' | 'mention';

export interface SlackConversationKey {
  /** Stable key used as the conversation map key + Cerebro external_chat_id. */
  key: string;
  surface: SlackSurfaceKind;
  /**
   * Whether this key rotates to a fresh Cerebro conversation after an idle
   * gap. DMs and top-level @mentions roll a new conversation once the user
   * has been silent past the idle window; a channel thread is a bounded
   * conversation and never rotates.
   */
  rotates: boolean;
}

/**
 * Map an inbound Slack message to a *stable* conversation key.
 *
 * The old scheme keyed by `(team, channel, thread_ts || ts)`, which in a DM
 * (no thread) collapsed to the message's own `ts` — a fresh key, and so a
 * fresh Cerebro conversation, for every single message. That broke memory and
 * defeated the per-thread single-flight guard. We now key by surface:
 *
 *  - DM (`im`/`mpim`): the whole DM is one rolling session. We deliberately
 *    ignore `thread_ts` so a threaded reply inside a DM continues the same
 *    conversation rather than forking a new one.
 *  - Channel thread: one conversation per thread root. Context for messages
 *    Cerebro never received (it only sees @mentions) comes from a
 *    `conversations.replies` backfill, not from a new key.
 *  - Top-level channel @mention: one rolling session per channel + user.
 */
export function conversationKey(args: {
  teamId: string;
  channel: string;
  channelType?: string;
  userId: string;
  ts: string;
  threadTs?: string | null;
}): SlackConversationKey {
  const team = args.teamId;
  const channel = args.channel;
  const isDm = args.channelType === 'im' || args.channelType === 'mpim';
  if (isDm) {
    return { key: `dm:${team}:${channel}`, surface: 'dm', rotates: true };
  }
  const threadTs = (args.threadTs ?? '').trim();
  if (threadTs) {
    return { key: `thread:${team}:${channel}:${threadTs}`, surface: 'thread', rotates: false };
  }
  return { key: `mention:${team}:${channel}:${args.userId}`, surface: 'mention', rotates: true };
}

/**
 * True when a rolling session has been idle long enough to roll over into a
 * fresh conversation. A non-finite / zero timestamp counts as expired so a
 * malformed entry self-heals into a new conversation.
 */
export function isSessionExpired(lastActivityAt: number, now: number, idleMs: number): boolean {
  if (!Number.isFinite(lastActivityAt) || lastActivityAt <= 0) return true;
  return now - lastActivityAt > idleMs;
}

/**
 * Coerce the persisted conversation map into the current entry shape. Legacy
 * installs stored a bare `string` (conversation id); we wrap those as a fresh,
 * reusable entry so existing chats aren't wiped on upgrade. Orphaned keys from
 * the old per-message scheme are simply never looked up again.
 */
export function migrateConversationMap(
  raw: unknown,
  now: number,
): Record<string, SlackConversationEntry> {
  const out: Record<string, SlackConversationEntry> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') {
      out[k] = { conversationId: v, lastActivityAt: now };
    } else if (
      v &&
      typeof v === 'object' &&
      typeof (v as { conversationId?: unknown }).conversationId === 'string'
    ) {
      const e = v as { conversationId: string; lastActivityAt?: unknown; lastSeenTs?: unknown };
      out[k] = {
        conversationId: e.conversationId,
        lastActivityAt: typeof e.lastActivityAt === 'number' ? e.lastActivityAt : now,
        lastSeenTs: typeof e.lastSeenTs === 'string' ? e.lastSeenTs : undefined,
      };
    }
  }
  return out;
}

// ── Allowlist parsing ─────────────────────────────────────────────

/**
 * Loose parser for Slack id lists.
 *  - Splits on commas / whitespace.
 *  - Strips surrounding mention syntax — both `<#C123|name>` and `<@U123>`.
 *  - Keeps anything that looks like a Slack id (C/G/D/U/W prefix + base36).
 *  - Allows the literal `*` (means "any channel" / "any user").
 */
export function parseAllowlistRaw(raw: string, kind: 'channel' | 'user'): string[] {
  const out: string[] = [];
  for (let token of raw.split(/[,\s]+/)) {
    token = token.trim();
    if (!token) continue;
    if (token === '*') {
      out.push('*');
      continue;
    }
    // Strip <#C123|name>, <@U123>, <#C123>, <@W123> wrappers.
    const stripped = token.replace(/^<[#@]([A-Z0-9]+)(?:\|[^>]*)?>$/, '$1');
    if (kind === 'channel' && /^[CGD][A-Z0-9]{6,}$/.test(stripped)) {
      out.push(stripped);
    } else if (kind === 'user' && /^[UW][A-Z0-9]{6,}$/.test(stripped)) {
      out.push(stripped);
    }
  }
  // Dedupe while preserving order.
  const seen = new Set<string>();
  return out.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
}

// ── Slash-command parsing ─────────────────────────────────────────

export type SlashSubcommand =
  | { verb: 'help' }
  | { verb: 'experts' }
  | { verb: 'expert'; sub: 'list' | 'set' | 'clear'; slug?: string }
  | { verb: 'status' }
  | { verb: 'ask'; text: string } // free-text question
  | { verb: 'empty' } // /cerebro with no args
  | { verb: 'unknown'; raw: string };

/**
 * Parse the args portion of `/cerebro <args>` into a structured subcommand.
 * The first word selects the verb; "experts" / "expert" / "help" / "status"
 * are reserved. Anything else (or the empty string) is treated as a free-text
 * question to forward to inference.
 */
export function parseSlashCommandText(raw: string): SlashSubcommand {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { verb: 'empty' };
  const firstSpace = trimmed.search(/\s/);
  const head = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
  const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();

  if (head === 'help' || head === '?') return { verb: 'help' };
  if (head === 'experts') return { verb: 'experts' };
  if (head === 'status') return { verb: 'status' };

  if (head === 'expert') {
    if (!rest) return { verb: 'expert', sub: 'list' };
    const subFirst = rest.toLowerCase().split(/\s+/)[0];
    if (subFirst === 'list') return { verb: 'expert', sub: 'list' };
    if (subFirst === 'clear' || subFirst === 'reset' || subFirst === 'off') {
      return { verb: 'expert', sub: 'clear' };
    }
    if (subFirst === 'set') {
      const slug = rest.replace(/^set\s+/i, '').trim();
      return { verb: 'expert', sub: 'set', slug: slug || undefined };
    }
    // bare "expert <slug>" defaults to set
    return { verb: 'expert', sub: 'set', slug: rest };
  }

  // Free-text question
  return { verb: 'ask', text: trimmed };
}

// ── Slack text chunking ───────────────────────────────────────────

/**
 * Slack's `chat.postMessage` text field caps at 40,000 chars. We chunk at
 * a smaller boundary (default 3500) because:
 *   - Block Kit blocks limit text to 3000 chars.
 *   - Smaller chunks render reliably on mobile.
 *   - Reading a 40-KB monolith inline is hostile UX.
 */
export function chunkSlackText(text: string, max = 3500): string[] {
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

// ── Event dedupe LRU ──────────────────────────────────────────────

/**
 * A tiny size-capped LRU specialised for Slack event_id dedupe.
 *
 * Slack retries unacked events up to 3× (immediate, 1min, 5min). Socket Mode
 * mostly avoids this, but reconnects can replay an envelope after the bridge
 * crashed mid-handler. We keep the last 10k event ids in memory; a returning
 * dup is dropped without invoking the handler.
 */
export class EventDedupe {
  private seen = new Map<string, number>();
  constructor(
    private readonly maxKeys: number = 10_000,
    private readonly ttlMs: number = 10 * 60_000, // 10 minutes
  ) {}

  /** Returns true on first-seen (caller should process), false on duplicate. */
  observe(eventId: string, now: number = Date.now()): boolean {
    // Expire stale entries lazily.
    if (this.seen.size > 0 && Math.random() < 0.01) {
      const cutoff = now - this.ttlMs;
      for (const [k, t] of this.seen) {
        if (t < cutoff) this.seen.delete(k);
      }
    }
    if (this.seen.has(eventId)) return false;
    this.seen.set(eventId, now);
    if (this.seen.size > this.maxKeys) {
      // Drop the oldest-inserted key. Map preserves insertion order.
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  /** Test helper. */
  size(): number {
    return this.seen.size;
  }
}

// ── Sliding window rate limiter (shared shape with telegram/helpers.ts) ──

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
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined && oldest !== key) {
        this.buckets.delete(oldest);
      }
    }
    return true;
  }
}

// ── Log redaction ─────────────────────────────────────────────────

/**
 * Scrub anything that could leak credentials before a payload hits the log.
 * Stripped: bot/app/user tokens (xoxb-/xoxa-/xoxp-/xapp-) and the message
 * `text` field (PII guardrail — log structure, not content).
 */
export function redactSlackPayload(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return scrubTokenish(value);
  if (Array.isArray(value)) return value.map(redactSlackPayload);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'text' || k === 'blocks' || k === 'attachments') {
        out[k] = typeof v === 'string' ? '<redacted>' : '<redacted>';
      } else {
        out[k] = redactSlackPayload(v);
      }
    }
    return out;
  }
  return value;
}

// ── Mention stripping ─────────────────────────────────────────────

/**
 * Strip the bot's own `<@BOTID>` mention from an inbound text. Slack renders
 * @cerebro as `<@U098ABC>` (or with optional display text), and the bot
 * doesn't want to feed its own mention back into the prompt.
 */
export function stripBotMention(text: string, botUserId: string | null): string {
  if (!botUserId || !text) return text ?? '';
  // <@U123> or <@U123|cerebro>
  const re = new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, 'g');
  return text.replace(re, '').trim();
}

// ── Slack-trigger routine parsing ─────────────────────────────────

interface CanvasDagJson extends DAGDefinition {
  trigger?: {
    triggerType?: string;
    config?: Record<string, unknown>;
  };
}

export type SlackFilterType = 'none' | 'keyword' | 'prefix' | 'regex';

export interface SlackTriggerConfig {
  /** Slack channel id to match — '*' matches any allowlisted channel/DM. */
  channel: string;
  /** Optional: restrict to messages from a specific Slack user id. */
  user_id?: string;
  /** Which surface fires the trigger. */
  surface?: 'app_mention' | 'message_im' | 'any';
  filter_type?: SlackFilterType;
  filter_value?: string;
}

export interface SlackTriggerRoutine {
  id: string;
  name: string;
  dag: DAGDefinition;
  trigger: SlackTriggerConfig;
}

export interface BackendRoutineRecord {
  id: string;
  name: string;
  is_enabled: boolean;
  trigger_type: string;
  dag_json: string | null;
}

export function parseSlackTriggerRoutine(record: BackendRoutineRecord): SlackTriggerRoutine | null {
  if (!record.dag_json) return null;
  let dag: CanvasDagJson;
  try {
    dag = JSON.parse(record.dag_json) as CanvasDagJson;
  } catch {
    return null;
  }
  if (dag.trigger?.triggerType !== 'trigger_slack_message') return null;
  const cfg = dag.trigger?.config ?? {};
  const channel = typeof cfg.channel === 'string' ? cfg.channel.trim() : '';
  if (!channel) return null;
  const user_id = typeof cfg.user_id === 'string' ? cfg.user_id.trim() : undefined;
  const rawSurface = typeof cfg.surface === 'string' ? cfg.surface : 'any';
  const surface: SlackTriggerConfig['surface'] =
    rawSurface === 'app_mention' || rawSurface === 'message_im' ? rawSurface : 'any';
  const rawFilterType = typeof cfg.filter_type === 'string' ? cfg.filter_type : 'none';
  const filter_type: SlackFilterType =
    rawFilterType === 'keyword' || rawFilterType === 'prefix' || rawFilterType === 'regex'
      ? rawFilterType
      : 'none';
  const filter_value = typeof cfg.filter_value === 'string' ? cfg.filter_value : '';
  const runtimeDag: DAGDefinition = { steps: dag.steps ?? [] };
  return {
    id: record.id,
    name: record.name,
    dag: runtimeDag,
    trigger: { channel, user_id, surface, filter_type, filter_value },
  };
}

export function matchesSlackFilter(
  text: string,
  filterType: SlackFilterType | undefined,
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
      return false;
    }
  }
  return false;
}

export function matchSlackRoutineTriggers(
  routines: SlackTriggerRoutine[],
  ctx: { channel: string; userId: string; surface: 'app_mention' | 'message_im'; text: string },
): SlackTriggerRoutine[] {
  const matched: SlackTriggerRoutine[] = [];
  for (const r of routines) {
    const target = r.trigger.channel;
    const chanMatches = target === '*' || target === ctx.channel;
    if (!chanMatches) continue;
    if (r.trigger.user_id && r.trigger.user_id !== '*' && r.trigger.user_id !== ctx.userId)
      continue;
    if (r.trigger.surface && r.trigger.surface !== 'any' && r.trigger.surface !== ctx.surface)
      continue;
    if (!matchesSlackFilter(ctx.text, r.trigger.filter_type, r.trigger.filter_value)) continue;
    matched.push(r);
  }
  return matched;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
