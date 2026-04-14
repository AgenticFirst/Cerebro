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
