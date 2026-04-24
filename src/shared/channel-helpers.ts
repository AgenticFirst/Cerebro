/**
 * Shared helpers for channel integrations (Telegram, WhatsApp, …).
 *
 * Lives here because both bridges want the same filter semantics and the
 * same rate-limit primitive. Keeping a single implementation means bug
 * fixes (e.g. the regex crash-guard below) ship to every channel at once.
 */

export type ChannelFilterType = 'none' | 'keyword' | 'prefix' | 'regex';

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True if `text` satisfies a routine's filter. Empty filter_value with a
 * non-'none' type means "match anything" (consistent with form ergonomics).
 */
export function matchesChannelFilter(
  text: string,
  filterType: ChannelFilterType | undefined,
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

/**
 * Sliding-window rate limiter. Caps total keys to prevent unbounded growth
 * if many strangers probe the bridge: once the cap is hit, the key with the
 * oldest activity is dropped.
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
      // Map preserves insertion order, so keys().next() is the first-seen key.
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined && oldest !== key) {
        this.buckets.delete(oldest);
      }
    }
    return true;
  }
}
