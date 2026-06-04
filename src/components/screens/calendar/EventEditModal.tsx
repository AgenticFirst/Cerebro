/** Create / edit form for a calendar event. */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import clsx from 'clsx';
import type { CalendarEventDTO, CalendarEventInput } from '../../../types/calendar';
import { LOCAL_CALENDAR_ACCOUNT_ID, LOCAL_CALENDAR_ID } from '../../../types/calendar';
import { useCalendar } from '../../../context/CalendarContext';
import Checkbox from '../../ui/Checkbox';
import DateTimeField from './DateTimeField';
import { roundedNow } from '../../../calendar/cal-utils';

interface Props {
  /** Existing event when editing; omit for create. */
  event?: CalendarEventDTO;
  /** Default start (create mode). */
  initialStart?: Date;
  /** Default end (create mode) — e.g. from a drag selection on the grid. */
  initialEnd?: Date;
  onClose: () => void;
}

/** Curated event color palette (label + hex). */
const EVENT_COLORS = [
  { name: 'Cyan', hex: '#06B6D4' },
  { name: 'Blue', hex: '#3B82F6' },
  { name: 'Violet', hex: '#8B5CF6' },
  { name: 'Pink', hex: '#EC4899' },
  { name: 'Red', hex: '#EF4444' },
  { name: 'Amber', hex: '#F59E0B' },
  { name: 'Emerald', hex: '#10B981' },
  { name: 'Slate', hex: '#64748B' },
];

export default function EventEditModal({ event, initialStart, initialEnd, onClose }: Props) {
  const { t } = useTranslation();
  const { createEvent, updateEvent, accounts } = useCalendar();

  // Calendars the user can create into: the built-in Local one + each connected
  // provider calendar. Defaults to a connected primary if any, else Local.
  const targetOptions = useMemo(() => {
    const opts = [
      {
        key: `${LOCAL_CALENDAR_ACCOUNT_ID}:${LOCAL_CALENDAR_ID}`,
        accountId: LOCAL_CALENDAR_ACCOUNT_ID,
        calendarId: LOCAL_CALENDAR_ID,
        label: 'Local',
      },
    ];
    for (const a of accounts) {
      for (const c of a.calendars ?? []) {
        if (c.selected === false) continue;
        opts.push({
          key: `${a.id}:${c.id}`,
          accountId: a.id,
          calendarId: c.id,
          label: `${c.name} · ${a.email}`,
        });
      }
    }
    return opts;
  }, [accounts]);

  const defaultTargetKey = useMemo(() => {
    const connected = accounts.find((a) => a.status === 'connected');
    if (connected) {
      const cal =
        connected.calendars?.find((c) => c.id === connected.primary_calendar_id) ??
        connected.calendars?.[0];
      if (cal) return `${connected.id}:${cal.id}`;
    }
    return `${LOCAL_CALENDAR_ACCOUNT_ID}:${LOCAL_CALENDAR_ID}`;
  }, [accounts]);

  const [targetKey, setTargetKey] = useState(defaultTargetKey);

  const defaultStart = event?.start_utc
    ? new Date(event.start_utc)
    : (initialStart ?? roundedNow());
  const defaultEnd = event?.end_utc
    ? new Date(event.end_utc)
    : (initialEnd ?? new Date(defaultStart.getTime() + 60 * 60_000));

  const [title, setTitle] = useState(event?.title ?? '');
  const [start, setStart] = useState<Date>(defaultStart);
  const [end, setEnd] = useState<Date>(defaultEnd);
  const [allDay, setAllDay] = useState(event?.all_day ?? false);
  const [location, setLocation] = useState(event?.location ?? '');
  const [description, setDescription] = useState(event?.description ?? '');
  const [attendees, setAttendees] = useState(
    (event?.attendees ?? []).map((a) => a.email).join(', '),
  );
  const [busy, setBusy] = useState(event ? event.transparency !== 'transparent' : true);
  const [visibility, setVisibility] = useState<CalendarEventInput['visibility']>(
    event?.visibility ?? 'default',
  );
  const [conference, setConference] = useState(false);
  const [color, setColor] = useState(event?.color ?? EVENT_COLORS[0].hex);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Guests + video conferencing only make sense on a connected provider calendar
  // (there's an account to send invites from and a Meet/Teams link to mint).
  const targetIsProvider = useMemo(() => {
    const target = targetOptions.find((o) => o.key === targetKey);
    const acc = accounts.find((a) => a.id === target?.accountId);
    return Boolean(
      acc &&
      acc.status === 'connected' &&
      (acc.provider === 'google' || acc.provider === 'outlook'),
    );
  }, [targetKey, targetOptions, accounts]);

  const submit = async () => {
    if (!title.trim()) {
      setErr(t('calendar.event.titleLabel'));
      return;
    }
    setSaving(true);
    setErr(null);
    const target = targetOptions.find((o) => o.key === targetKey);
    const input: CalendarEventInput = {
      account_id: target?.accountId,
      calendar_id: target?.calendarId,
      title: title.trim(),
      start: start.toISOString(),
      end: end.toISOString(),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      all_day: allDay,
      location: location.trim() || undefined,
      description: description.trim() || undefined,
      // Guests/conferencing are provider-only.
      attendees: targetIsProvider
        ? attendees
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
      busy,
      visibility,
      color,
      conference: event ? undefined : targetIsProvider && conference,
    };
    const res = event ? await updateEvent(event.id, input) : await createEvent(input);
    setSaving(false);
    if (res.ok) {
      onClose();
    } else {
      setErr(res.error ?? 'error');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[480px] max-w-[92vw] rounded-xl border border-border-subtle bg-bg-base shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
          <h2 className="flex-1 text-[15px] font-semibold text-text-primary">
            {event ? t('calendar.event.edit') : t('calendar.newEvent')}
          </h2>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-secondary">
            <X size={16} />
          </button>
        </div>

        <div className="px-4 py-3 space-y-3 max-h-[70vh] overflow-y-auto scrollbar-thin">
          <Field label={t('calendar.event.titleLabel')}>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full bg-bg-surface border border-border-subtle rounded-md px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
            />
          </Field>

          {!event && targetOptions.length > 1 && (
            <Field label={t('calendar.event.calendarLabel')}>
              <select
                value={targetKey}
                onChange={(e) => setTargetKey(e.target.value)}
                className="w-full bg-bg-surface border border-border-subtle rounded-md px-2 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
              >
                {targetOptions.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Checkbox checked={allDay} onChange={setAllDay} label={t('calendar.event.allDayLabel')} />

          <div className="grid grid-cols-2 gap-3">
            <Field label={t('calendar.event.startLabel')}>
              <DateTimeField
                value={start}
                mode={allDay ? 'date' : 'datetime'}
                onChange={(d) => {
                  setStart(d);
                  // Keep end after start (preserve the existing duration).
                  if (d >= end) setEnd(new Date(d.getTime() + 60 * 60_000));
                }}
              />
            </Field>
            <Field label={t('calendar.event.endLabel')}>
              <DateTimeField
                value={end}
                mode={allDay ? 'date' : 'datetime'}
                onChange={(d) => setEnd(d)}
              />
            </Field>
          </div>

          <Field label={t('calendar.event.locationLabel')}>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              className="w-full bg-bg-surface border border-border-subtle rounded-md px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
            />
          </Field>

          {targetIsProvider ? (
            <Field
              label={t('calendar.event.attendeesLabel')}
              hint={t('calendar.event.attendeesHint')}
            >
              <input
                value={attendees}
                onChange={(e) => setAttendees(e.target.value)}
                placeholder="alice@example.com, bob@example.com"
                className="w-full bg-bg-surface border border-border-subtle rounded-md px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
              />
            </Field>
          ) : (
            <Field label={t('calendar.event.attendeesLabel')}>
              <p className="text-[12px] text-text-tertiary bg-bg-surface/60 border border-border-subtle rounded-md px-2.5 py-2">
                {t('calendar.event.guestsLocalNote')}
              </p>
            </Field>
          )}

          {/* Color */}
          <Field label={t('calendar.event.colorLabel')}>
            <div className="flex items-center gap-2">
              {EVENT_COLORS.map((c) => (
                <button
                  key={c.hex}
                  type="button"
                  title={c.name}
                  onClick={() => setColor(c.hex)}
                  className={clsx(
                    'w-6 h-6 rounded-full transition-transform hover:scale-110',
                    color === c.hex ? 'ring-2 ring-offset-2 ring-offset-bg-base ring-white/70' : '',
                  )}
                  style={{ background: c.hex }}
                />
              ))}
            </div>
          </Field>

          <Field label={t('calendar.event.descriptionLabel')}>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full bg-bg-surface border border-border-subtle rounded-md px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent resize-none"
            />
          </Field>

          <div className="flex items-center gap-4">
            <Checkbox checked={busy} onChange={setBusy} label={t('calendar.event.busyLabel')} />
            <select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as CalendarEventInput['visibility'])}
              className="bg-bg-surface border border-border-subtle rounded-md px-2 py-1 text-[12px] text-text-secondary outline-none focus:border-accent"
            >
              <option value="default">{t('calendar.event.visibilityLabel')}</option>
              <option value="public">{t('calendar.free')}</option>
              <option value="private">{t('calendar.private')}</option>
            </select>
          </div>

          {!event && targetIsProvider && (
            <Checkbox
              checked={conference}
              onChange={setConference}
              label={t('calendar.event.conferenceLabel')}
            />
          )}

          {err && <p className="text-[12px] text-red-400">{err}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-4 py-2.5">
          <button
            onClick={onClose}
            className="px-3 py-1 rounded-md text-[12px] text-text-tertiary hover:text-text-secondary"
          >
            {t('calendar.event.cancel')}
          </button>
          <button
            onClick={submit}
            disabled={saving}
            className="px-3 py-1 rounded-md text-[12px] bg-accent text-black font-medium hover:brightness-110 disabled:opacity-50"
          >
            {saving ? t('calendar.event.saving') : t('calendar.event.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[11px] uppercase tracking-wide text-text-tertiary mb-1">
        {label}
      </label>
      {children}
      {hint && <p className="text-[10px] text-text-tertiary mt-0.5">{hint}</p>}
    </div>
  );
}
