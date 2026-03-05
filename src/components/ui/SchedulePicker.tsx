import { useMemo } from 'react';
import clsx from 'clsx';
import {
  type DayOfWeek,
  ALL_DAYS,
  WEEKDAYS,
  describeSchedule,
} from '../../utils/cron-helpers';

const DAY_LABELS: { key: DayOfWeek; short: string }[] = [
  { key: 'mon', short: 'Mo' },
  { key: 'tue', short: 'Tu' },
  { key: 'wed', short: 'We' },
  { key: 'thu', short: 'Th' },
  { key: 'fri', short: 'Fr' },
  { key: 'sat', short: 'Sa' },
  { key: 'sun', short: 'Su' },
];

interface SchedulePickerProps {
  days: DayOfWeek[];
  time: string;
  onDaysChange: (days: DayOfWeek[]) => void;
  onTimeChange: (time: string) => void;
}

export default function SchedulePicker({
  days,
  time,
  onDaysChange,
  onTimeChange,
}: SchedulePickerProps) {
  const toggleDay = (day: DayOfWeek) => {
    if (days.includes(day)) {
      onDaysChange(days.filter((d) => d !== day));
    } else {
      onDaysChange([...days, day]);
    }
  };

  const isWeekdays =
    WEEKDAYS.every((d) => days.includes(d)) && days.length === 5;
  const isEveryDay = days.length === 7;

  const tzAbbr = useMemo(() => {
    const parts = Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
      .formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  }, []);

  const preview = useMemo(() => {
    if (days.length === 0) return 'Select at least one day';
    const desc = describeSchedule({ days, time });
    return tzAbbr ? `${desc} (${tzAbbr})` : desc;
  }, [days, time, tzAbbr]);

  return (
    <div className="space-y-3">
      {/* Preset shortcuts */}
      <div className="flex gap-2 text-[11px]">
        <button
          type="button"
          onClick={() => onDaysChange([...WEEKDAYS])}
          className={clsx(
            'px-2 py-0.5 rounded-full border transition-colors',
            isWeekdays
              ? 'border-accent/30 bg-accent/10 text-accent'
              : 'border-border-subtle text-text-tertiary hover:text-text-secondary hover:border-border-default',
          )}
        >
          Weekdays
        </button>
        <button
          type="button"
          onClick={() => onDaysChange([...ALL_DAYS])}
          className={clsx(
            'px-2 py-0.5 rounded-full border transition-colors',
            isEveryDay
              ? 'border-accent/30 bg-accent/10 text-accent'
              : 'border-border-subtle text-text-tertiary hover:text-text-secondary hover:border-border-default',
          )}
        >
          Every day
        </button>
      </div>

      {/* Day pills */}
      <div className="flex gap-1.5">
        {DAY_LABELS.map(({ key, short }) => {
          const active = days.includes(key);
          return (
            <button
              key={key}
              type="button"
              onClick={() => toggleDay(key)}
              className={clsx(
                'w-8 h-8 rounded-lg text-xs font-medium transition-colors border',
                active
                  ? 'bg-accent/15 border-accent/30 text-accent'
                  : 'bg-bg-surface border-border-subtle text-text-tertiary hover:text-text-secondary hover:border-border-default',
              )}
            >
              {short}
            </button>
          );
        })}
      </div>

      {/* Time picker */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">
          Time
        </label>
        <input
          type="time"
          value={time}
          onChange={(e) => onTimeChange(e.target.value)}
          className="bg-bg-surface border border-border-subtle rounded-lg px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:border-accent/40 transition-colors"
        />
      </div>

      {/* Preview */}
      <p className="text-xs text-text-secondary">
        {preview}
      </p>
    </div>
  );
}
