/**
 * Pure helpers used by WhatsAppBridge. Kept here so tests can exercise them
 * without having to mock Electron, Baileys sockets, or the engine bus.
 *
 * Channel-agnostic bits (filter matching, rate limiting, regex escape) live
 * in ../shared/channel-helpers.ts so the Telegram bridge can share them.
 */

import type { DAGDefinition } from '../engine/dag/types';
import { matchesChannelFilter, type ChannelFilterType } from '../shared/channel-helpers';
import type {
  BackendRoutineRecord,
  WhatsAppFilterType,
  WhatsAppTriggerRoutine,
} from './types';

// Re-export for external callers that still import the limiter from this module.
export { SlidingWindowLimiter } from '../shared/channel-helpers';

// ── Phone / JID normalization ────────────────────────────────────

/**
 * Accept any of the common WhatsApp identity shapes and return a canonical
 * E.164-ish phone string (no +). This is what we key conversations on and
 * what we compare against the allowlist.
 *
 *   "+14155552671"              → "14155552671"
 *   "14155552671"               → "14155552671"
 *   "14155552671@s.whatsapp.net"→ "14155552671"
 *   "14155552671@c.us"          → "14155552671"
 *   "14155552671:7@s.whatsapp.net" → "14155552671" (device suffix dropped)
 */
export function normalizePhone(raw: string): string {
  if (!raw) return '';
  let s = raw.trim();
  // Strip everything after '@' (the JID host) and ':' (device suffix).
  const atIdx = s.indexOf('@');
  if (atIdx >= 0) s = s.slice(0, atIdx);
  const colonIdx = s.indexOf(':');
  if (colonIdx >= 0) s = s.slice(0, colonIdx);
  // Drop '+' and any separators; Baileys uses bare digits.
  s = s.replace(/^\+/, '').replace(/[^\d]/g, '');
  return s;
}

/** Build a Baileys "user JID" from a phone string. */
export function toUserJid(phone: string): string {
  const digits = normalizePhone(phone);
  if (!digits) return '';
  return `${digits}@s.whatsapp.net`;
}

/** Display form (re-prefixed with '+') for UI and logs. */
export function toDisplayPhone(raw: string): string {
  const digits = normalizePhone(raw);
  return digits ? `+${digits}` : '';
}

// ── Allowlist parsing / check ────────────────────────────────────

/** Parse a comma/space separated list of phone numbers into normalized digits.
 *  Accepts '*' as a wildcard allow-all entry. */
export function parseAllowlistRaw(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => (s === '*' ? '*' : normalizePhone(s)))
    .filter((s) => s === '*' || /^\d{5,}$/.test(s));
}

export function isAllowed(phoneOrJid: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return false;
  if (allowlist.includes('*')) return true;
  const digits = normalizePhone(phoneOrJid);
  return allowlist.includes(digits);
}

// ── Trigger parsing ──────────────────────────────────────────────

interface CanvasDagJson extends DAGDefinition {
  trigger?: {
    triggerType?: string;
    config?: Record<string, unknown>;
  };
}

/**
 * Pull the whatsapp trigger config out of a routine's dag_json. The trigger
 * lives on `CanvasDefinition.trigger`, not in `steps`, so that's where we
 * read it. Returns null if the routine doesn't have a usable whatsapp
 * trigger.
 */
export function parseWhatsAppTriggerRoutine(
  record: BackendRoutineRecord,
): WhatsAppTriggerRoutine | null {
  if (!record.dag_json) return null;
  let dag: CanvasDagJson;
  try {
    dag = JSON.parse(record.dag_json) as CanvasDagJson;
  } catch {
    return null;
  }
  if (dag.trigger?.triggerType !== 'trigger_whatsapp_message') return null;
  const cfg = dag.trigger?.config ?? {};
  const rawPhone = typeof cfg.phone_number === 'string' ? cfg.phone_number.trim() : '';
  // '*' wildcard or a specific number; empty = no trigger.
  const phone = rawPhone === '*' ? '*' : normalizePhone(rawPhone);
  if (!phone) return null;
  const rawFilterType = typeof cfg.filter_type === 'string' ? cfg.filter_type : 'none';
  const filter_type: WhatsAppFilterType =
    rawFilterType === 'keyword' || rawFilterType === 'prefix' || rawFilterType === 'regex'
      ? rawFilterType
      : 'none';
  const filter_value = typeof cfg.filter_value === 'string' ? cfg.filter_value : '';
  const runtimeDag: DAGDefinition = { steps: dag.steps ?? [] };
  return {
    id: record.id,
    name: record.name,
    dag: runtimeDag,
    trigger: { phone_number: phone, filter_type, filter_value },
  };
}

export function matchesWhatsAppFilter(
  text: string,
  filterType: WhatsAppFilterType | undefined,
  filterValue: string | undefined,
): boolean {
  return matchesChannelFilter(text, filterType as ChannelFilterType | undefined, filterValue);
}

export function matchWhatsAppRoutineTriggers(
  routines: WhatsAppTriggerRoutine[],
  phoneNumber: string,
  text: string,
): WhatsAppTriggerRoutine[] {
  const normalized = normalizePhone(phoneNumber);
  const matched: WhatsAppTriggerRoutine[] = [];
  for (const r of routines) {
    const target = r.trigger.phone_number;
    const phoneMatches = target === '*' || target === normalized;
    if (!phoneMatches) continue;
    if (!matchesWhatsAppFilter(text, r.trigger.filter_type, r.trigger.filter_value)) continue;
    matched.push(r);
  }
  return matched;
}
