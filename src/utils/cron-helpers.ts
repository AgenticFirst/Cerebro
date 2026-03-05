/**
 * Schedule ↔ Cron expression conversion utilities.
 * Pure functions — no Node deps, safe for renderer.
 */

export type DayOfWeek = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

export interface ScheduleConfig {
  days: DayOfWeek[];
  time: string; // '09:00' (24h format)
}

const DAY_TO_CRON: Record<DayOfWeek, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const CRON_TO_DAY: Record<number, DayOfWeek> = {
  0: 'sun',
  1: 'mon',
  2: 'tue',
  3: 'wed',
  4: 'thu',
  5: 'fri',
  6: 'sat',
};

const DAY_LABELS: Record<DayOfWeek, string> = {
  sun: 'Sun',
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
};

const ALL_DAYS: DayOfWeek[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEKDAYS: DayOfWeek[] = ['mon', 'tue', 'wed', 'thu', 'fri'];

/**
 * Convert a user-friendly schedule to a cron expression.
 * e.g. { days: ['mon','tue','wed','thu','fri'], time: '09:00' } → '0 9 * * 1-5'
 */
export function scheduleToCron(config: ScheduleConfig): string {
  const [hourStr, minuteStr] = config.time.split(':');
  const minute = parseInt(minuteStr, 10);
  const hour = parseInt(hourStr, 10);

  if (config.days.length === 0) {
    throw new Error('scheduleToCron: days array must not be empty');
  }

  const cronNums = config.days
    .map((d) => DAY_TO_CRON[d])
    .sort((a, b) => a - b);

  // Compress consecutive days into ranges
  const dayField = compressRanges(cronNums);

  return `${minute} ${hour} * * ${dayField}`;
}

/** Compress sorted numbers into range notation: [1,2,3,5] → '1-3,5' */
function compressRanges(nums: number[]): string {
  if (nums.length === 0) return '*';
  if (nums.length === 7) return '*';

  const ranges: string[] = [];
  let start = nums[0];
  let end = nums[0];

  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === end + 1) {
      end = nums[i];
    } else {
      ranges.push(start === end ? String(start) : `${start}-${end}`);
      start = nums[i];
      end = nums[i];
    }
  }
  ranges.push(start === end ? String(start) : `${start}-${end}`);

  return ranges.join(',');
}

/**
 * Parse a cron expression back to a ScheduleConfig for editing.
 * Only handles standard 5-field expressions with simple day-of-week patterns.
 * Returns null if the expression can't be cleanly represented as days + time.
 */
export function cronToSchedule(expr: string): ScheduleConfig | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minuteStr, hourStr, dayOfMonth, month, dayOfWeek] = parts;

  // Only handle simple patterns: specific minute/hour, any day-of-month/month
  if (dayOfMonth !== '*' || month !== '*') return null;

  const minute = parseInt(minuteStr, 10);
  const hour = parseInt(hourStr, 10);
  if (isNaN(minute) || isNaN(hour) || minute < 0 || minute > 59 || hour < 0 || hour > 23) {
    return null;
  }

  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  // Parse day-of-week field
  const days = parseDayOfWeek(dayOfWeek);
  if (!days) return null;

  return { days, time };
}

/** Map named days (case-insensitive) to cron numbers. */
const NAMED_DAY_TO_NUM: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

/**
 * Normalize a single day token (number or name) to a raw cron number (0-7), or null.
 * Does NOT normalize 7→0 so that range expansion works correctly for wrapping ranges.
 */
function parseDayToken(token: string): number | null {
  const named = NAMED_DAY_TO_NUM[token.toLowerCase()];
  if (named !== undefined) return named;
  const num = parseInt(token, 10);
  if (isNaN(num) || num < 0 || num > 7) return null;
  return num;
}

/** Normalize raw day number to 0-6 (treats 7 as Sunday/0). */
function normalizeDay(n: number): number {
  return n === 7 ? 0 : n;
}

/** Parse cron day-of-week field into DayOfWeek array. */
function parseDayOfWeek(field: string): DayOfWeek[] | null {
  if (field === '*') return [...ALL_DAYS];

  const days = new Set<number>();

  for (const part of field.split(',')) {
    const rangeMatch = part.match(/^([a-zA-Z0-9]+)-([a-zA-Z0-9]+)$/);
    if (rangeMatch) {
      const start = parseDayToken(rangeMatch[1]);
      const end = parseDayToken(rangeMatch[2]);
      if (start === null || end === null) return null;
      if (start <= end) {
        for (let i = start; i <= end; i++) days.add(normalizeDay(i));
      } else {
        // Wrap-around range (e.g. FRI-SUN = 5-0 → 5,6,0)
        for (let i = start; i <= 7; i++) days.add(normalizeDay(i));
        for (let i = 0; i <= end; i++) days.add(normalizeDay(i));
      }
    } else {
      const num = parseDayToken(part);
      if (num === null) return null;
      days.add(normalizeDay(num));
    }
  }

  return Array.from(days)
    .sort((a, b) => a - b)
    .map((n) => CRON_TO_DAY[n]);
}

/**
 * Generate a human-readable description of a schedule.
 * e.g. "Every weekday at 9:00 AM" or "Mon, Wed, Fri at 2:30 PM"
 */
export function describeSchedule(config: ScheduleConfig): string {
  const timeStr = formatTime12h(config.time);

  if (config.days.length === 0 || config.days.length === 7) {
    return `Every day at ${timeStr}`;
  }

  const sortedDays = [...config.days].sort(
    (a, b) => DAY_TO_CRON[a] - DAY_TO_CRON[b],
  );

  // Check for weekdays
  if (
    sortedDays.length === 5 &&
    WEEKDAYS.every((d) => sortedDays.includes(d))
  ) {
    return `Weekdays at ${timeStr}`;
  }

  // Check for weekends
  if (
    sortedDays.length === 2 &&
    sortedDays.includes('sat') &&
    sortedDays.includes('sun')
  ) {
    return `Weekends at ${timeStr}`;
  }

  const dayNames = sortedDays.map((d) => DAY_LABELS[d]);
  return `${dayNames.join(', ')} at ${timeStr}`;
}

/** Describe a cron expression in human-readable form. Returns null if not parseable. */
export function describeCron(expr: string): string | null {
  const config = cronToSchedule(expr);
  if (!config) return null;
  return describeSchedule(config);
}

/** Convert 24h time string to 12h format: '14:30' → '2:30 PM' */
function formatTime12h(time: string): string {
  const [hourStr, minuteStr] = time.split(':');
  let hour = parseInt(hourStr, 10);
  const minute = minuteStr;
  const ampm = hour >= 12 ? 'PM' : 'AM';
  if (hour === 0) hour = 12;
  else if (hour > 12) hour -= 12;
  return `${hour}:${minute} ${ampm}`;
}

export { ALL_DAYS, WEEKDAYS };
