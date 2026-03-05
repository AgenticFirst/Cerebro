import { describe, it, expect } from 'vitest';
import {
  scheduleToCron,
  cronToSchedule,
  describeSchedule,
  ALL_DAYS,
  WEEKDAYS,
  type ScheduleConfig,
} from '../cron-helpers';

// ── scheduleToCron ─────────────────────────────────────────────

describe('scheduleToCron', () => {
  it('converts weekdays at 9:00', () => {
    expect(scheduleToCron({ days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '09:00' }))
      .toBe('0 9 * * 1-5');
  });

  it('converts all days at midnight', () => {
    expect(scheduleToCron({ days: [...ALL_DAYS], time: '00:00' }))
      .toBe('0 0 * * *');
  });

  it('converts a single day', () => {
    expect(scheduleToCron({ days: ['sat'], time: '14:30' }))
      .toBe('30 14 * * 6');
  });

  it('converts non-consecutive days', () => {
    expect(scheduleToCron({ days: ['mon', 'wed', 'fri'], time: '08:15' }))
      .toBe('15 8 * * 1,3,5');
  });

  it('compresses consecutive + standalone days', () => {
    // Mon-Wed + Sat → 1-3,6
    expect(scheduleToCron({ days: ['mon', 'tue', 'wed', 'sat'], time: '10:00' }))
      .toBe('0 10 * * 1-3,6');
  });

  it('throws on empty days', () => {
    expect(() => scheduleToCron({ days: [], time: '09:00' })).toThrow('days array must not be empty');
  });

  it('handles weekends', () => {
    expect(scheduleToCron({ days: ['sat', 'sun'], time: '11:00' }))
      .toBe('0 11 * * 0,6');
  });
});

// ── cronToSchedule ─────────────────────────────────────────────

describe('cronToSchedule', () => {
  it('parses weekday cron', () => {
    const result = cronToSchedule('0 9 * * 1-5');
    expect(result).toEqual({ days: WEEKDAYS, time: '09:00' });
  });

  it('parses wildcard day-of-week as all days', () => {
    const result = cronToSchedule('30 14 * * *');
    expect(result).toEqual({ days: [...ALL_DAYS], time: '14:30' });
  });

  it('parses comma-separated days', () => {
    const result = cronToSchedule('0 8 * * 1,3,5');
    expect(result).toEqual({ days: ['mon', 'wed', 'fri'], time: '08:00' });
  });

  it('returns null for non-5-field expression', () => {
    expect(cronToSchedule('0 9 * *')).toBeNull();
  });

  it('returns null when day-of-month is not wildcard', () => {
    expect(cronToSchedule('0 9 15 * *')).toBeNull();
  });

  it('returns null when month is not wildcard', () => {
    expect(cronToSchedule('0 9 * 3 *')).toBeNull();
  });

  it('returns null for invalid minute', () => {
    expect(cronToSchedule('60 9 * * *')).toBeNull();
  });

  it('returns null for invalid hour', () => {
    expect(cronToSchedule('0 25 * * *')).toBeNull();
  });

  it('handles named days', () => {
    const result = cronToSchedule('0 9 * * MON-FRI');
    expect(result).toEqual({ days: WEEKDAYS, time: '09:00' });
  });

  it('handles wrap-around range (fri-sun)', () => {
    const result = cronToSchedule('0 9 * * 5-0');
    expect(result).not.toBeNull();
    expect(result!.days).toContain('fri');
    expect(result!.days).toContain('sat');
    expect(result!.days).toContain('sun');
  });

  it('handles day 7 as Sunday', () => {
    const result = cronToSchedule('0 9 * * 7');
    expect(result).toEqual({ days: ['sun'], time: '09:00' });
  });

  it('pads single-digit hour/minute with zeros', () => {
    const result = cronToSchedule('5 7 * * 1');
    expect(result).toEqual({ days: ['mon'], time: '07:05' });
  });
});

// ── describeSchedule ───────────────────────────────────────────

describe('describeSchedule', () => {
  it('describes weekdays', () => {
    expect(describeSchedule({ days: [...WEEKDAYS], time: '09:00' }))
      .toBe('Weekdays at 9:00 AM');
  });

  it('describes all days', () => {
    expect(describeSchedule({ days: [...ALL_DAYS], time: '09:00' }))
      .toBe('Every day at 9:00 AM');
  });

  it('describes empty days as every day', () => {
    expect(describeSchedule({ days: [], time: '09:00' }))
      .toBe('Every day at 9:00 AM');
  });

  it('describes weekends', () => {
    expect(describeSchedule({ days: ['sat', 'sun'], time: '11:00' }))
      .toBe('Weekends at 11:00 AM');
  });

  it('describes custom days', () => {
    expect(describeSchedule({ days: ['mon', 'wed', 'fri'], time: '14:30' }))
      .toBe('Mon, Wed, Fri at 2:30 PM');
  });

  it('describes single day', () => {
    expect(describeSchedule({ days: ['tue'], time: '08:00' }))
      .toBe('Tue at 8:00 AM');
  });

  it('formats PM times correctly', () => {
    expect(describeSchedule({ days: ['mon'], time: '23:00' }))
      .toBe('Mon at 11:00 PM');
  });

  it('formats midnight as 12:00 AM', () => {
    expect(describeSchedule({ days: ['mon'], time: '00:00' }))
      .toBe('Mon at 12:00 AM');
  });

  it('formats noon as 12:00 PM', () => {
    expect(describeSchedule({ days: ['mon'], time: '12:00' }))
      .toBe('Mon at 12:00 PM');
  });
});

// ── Round-trip ─────────────────────────────────────────────────

describe('round-trip', () => {
  const configs: ScheduleConfig[] = [
    { days: [...WEEKDAYS], time: '09:00' },
    { days: [...ALL_DAYS], time: '00:00' },
    { days: ['mon', 'wed', 'fri'], time: '14:30' },
    { days: ['sat'], time: '08:15' },
    { days: ['sat', 'sun'], time: '11:00' },
  ];

  for (const config of configs) {
    it(`round-trips ${JSON.stringify(config)}`, () => {
      const cron = scheduleToCron(config);
      const parsed = cronToSchedule(cron);
      expect(parsed).not.toBeNull();
      expect(parsed!.time).toBe(config.time);
      // Days may be reordered (sorted by cron number), so compare as sets
      expect(new Set(parsed!.days)).toEqual(new Set(config.days));
    });
  }
});
