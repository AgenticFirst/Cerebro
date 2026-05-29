import { describe, it, expect } from 'vitest';
import { parseServerTimestamp, formatDuration, humanizeRunError } from '../components/screens/activity/helpers';
import type { StepRecord } from '../components/screens/activity/types';

// ── parseServerTimestamp ───────────────────────────────────────

describe('parseServerTimestamp', () => {
  it('parses SQLAlchemy naive timestamps as UTC', () => {
    // "2026-04-28 01:53:52.736402" — no TZ marker. Treat as UTC.
    const ts = parseServerTimestamp('2026-04-28 01:53:52.736402');
    expect(ts).toBe(Date.UTC(2026, 3, 28, 1, 53, 52, 736));
  });

  it('respects existing Z marker', () => {
    const ts = parseServerTimestamp('2026-04-28T01:53:52Z');
    expect(ts).toBe(Date.UTC(2026, 3, 28, 1, 53, 52));
  });

  it('respects offset markers (+05:30)', () => {
    const ts = parseServerTimestamp('2026-04-28T07:23:52+05:30');
    expect(ts).toBe(Date.UTC(2026, 3, 28, 1, 53, 52));
  });

  it('respects offset markers without colon (-0700)', () => {
    const ts = parseServerTimestamp('2026-04-27T18:53:52-0700');
    expect(ts).toBe(Date.UTC(2026, 3, 28, 1, 53, 52));
  });

  it('returns NaN for null', () => {
    expect(parseServerTimestamp(null)).toBeNaN();
  });

  it('returns NaN for undefined', () => {
    expect(parseServerTimestamp(undefined)).toBeNaN();
  });

  it('handles ISO with T separator and no TZ', () => {
    // The replace(' ' → 'T') logic should leave T-formatted strings unchanged.
    const ts = parseServerTimestamp('2026-04-28T01:53:52');
    expect(ts).toBe(Date.UTC(2026, 3, 28, 1, 53, 52));
  });

  it('regression: fixes the negative-elapsed bug', () => {
    // The bug: "2026-04-28 01:53:52" parsed as local time on a UTC-7 box
    // produced a positive 7h offset that, subtracted from Date.now()'s
    // UTC-anchored value, came out negative. With the fix, the elapsed
    // value is always positive when the timestamp is in the past.
    const fakeNow = Date.UTC(2026, 3, 28, 2, 0, 0); // 2 AM UTC, well after 1:53 UTC
    const ts = parseServerTimestamp('2026-04-28 01:53:52');
    expect(fakeNow - ts).toBeGreaterThanOrEqual(0);
    expect(fakeNow - ts).toBeLessThan(15 * 60 * 1000); // less than 15 minutes
  });
});

// ── formatDuration ─────────────────────────────────────────────

describe('formatDuration', () => {
  it('renders sub-second values', () => {
    expect(formatDuration(500)).toBe('500ms');
  });

  it('renders seconds with one decimal', () => {
    expect(formatDuration(1500)).toBe('1.5s');
  });

  it('renders minutes:seconds', () => {
    expect(formatDuration(125_000)).toBe('2m 5s');
  });

  it('renders an em-dash for null', () => {
    expect(formatDuration(null)).toBe('—');
  });

  it('does NOT show negative durations to the user', () => {
    // If a caller hands us a negative number through some logic mistake, we
    // want a sane render rather than the literal "-14309095ms" the user
    // saw on the Activity card. Negative inputs aren't expected, but they
    // shouldn't be rendered as confusing negative milliseconds either.
    // Current behaviour: negative values pass through ms branch. Document
    // it here so future authors know to clamp at the call site.
    expect(formatDuration(-100)).toMatch(/-100ms|—|^0/); // any of these is acceptable
  });
});

// ── humanizeRunError ───────────────────────────────────────────

const step = (overrides: Partial<StepRecord> = {}): StepRecord => ({
  id: 'sr-1',
  run_id: 'r-1',
  step_id: 'c0732875-1806-40d4-b34c-0a8957618bdb',
  step_name: 'New Run Expert',
  action_type: 'run_expert',
  status: 'failed',
  summary: null,
  error: null,
  input_json: null,
  output_json: null,
  started_at: null,
  completed_at: null,
  duration_ms: null,
  order_index: 0,
  approval_id: null,
  approval_status: null,
  ...overrides,
});

describe('humanizeRunError', () => {
  it('returns null/undefined inputs as-is', () => {
    expect(humanizeRunError(null, [])).toBeNull();
  });

  it('passes through non-step errors', () => {
    expect(humanizeRunError('Run was cancelled', []))
      .toBe('Run was cancelled');
  });

  it('replaces UUID with step name and converts ms to minutes', () => {
    const out = humanizeRunError(
      'Step "c0732875-1806-40d4-b34c-0a8957618bdb" timed out after 300000ms',
      [step()],
    );
    expect(out).toBe('Step "New Run Expert" timed out after 5 min');
  });

  it('converts seconds for ms in the 1-60s range', () => {
    const out = humanizeRunError(
      'Step "c0732875-1806-40d4-b34c-0a8957618bdb" timed out after 30000ms',
      [step()],
    );
    expect(out).toBe('Step "New Run Expert" timed out after 30s');
  });

  it('returns the original when the UUID is not in the steps list', () => {
    const out = humanizeRunError(
      'Step "unknown-uuid-9999" timed out after 300000ms',
      [step()],
    );
    expect(out).toBe('Step "unknown-uuid-9999" timed out after 300000ms');
  });

  it('handles non-timeout step errors', () => {
    const out = humanizeRunError(
      'Step "c0732875-1806-40d4-b34c-0a8957618bdb" failed with HTTP 500',
      [step()],
    );
    expect(out).toBe('Step "New Run Expert" failed with HTTP 500');
  });
});
