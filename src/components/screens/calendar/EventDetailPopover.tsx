/** Read view for a single event with edit / delete / RSVP actions. */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, MapPin, Users, Pencil, Trash2, Lock, Video, AlertTriangle } from 'lucide-react';
import type { CalendarOccurrence } from '../../../calendar/recurrence';
import type { RsvpResponse } from '../../../types/calendar';
import { useCalendar } from '../../../context/CalendarContext';
import AlertModal from '../../ui/AlertModal';

interface Props {
  occurrence: CalendarOccurrence;
  onClose: () => void;
  onEdit: () => void;
}

function fmtRange(startMs: number, endMs: number, allDay: boolean): string {
  const s = new Date(startMs);
  const e = new Date(endMs);
  if (allDay)
    return s.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const date = s.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  return `${date} · ${s.toLocaleTimeString(undefined, opts)} – ${e.toLocaleTimeString(undefined, opts)}`;
}

export default function EventDetailPopover({ occurrence, onClose, onEdit }: Props) {
  const { t } = useTranslation();
  const { deleteEvent, rsvp } = useCalendar();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ev = occurrence.event;

  const canEdit = ev.origin === 'cerebro' || Boolean(ev.provider_event_id);
  const isInvite = Boolean(ev.attendees && ev.attendees.length > 0);

  const doDelete = async () => {
    setConfirmDelete(false);
    setBusy(true);
    await deleteEvent(ev.id);
    setBusy(false);
    onClose();
  };

  const doRsvp = async (response: RsvpResponse) => {
    setBusy(true);
    await rsvp(ev.id, response);
    setBusy(false);
    onClose();
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        onClick={onClose}
      >
        <div
          className="w-[420px] max-w-[90vw] rounded-xl border border-border-subtle bg-bg-base shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start gap-2 px-4 pt-4">
            <h2 className="flex-1 text-[15px] font-semibold text-text-primary">
              {ev.visibility === 'private' ? t('calendar.private') : ev.title || '(no title)'}
            </h2>
            <button onClick={onClose} className="text-text-tertiary hover:text-text-secondary">
              <X size={16} />
            </button>
          </div>

          <div className="px-4 py-3 space-y-2 text-[13px] text-text-secondary">
            <div>{fmtRange(occurrence.startMs, occurrence.endMs, ev.all_day)}</div>
            {ev.location && (
              <div className="flex items-center gap-1.5">
                <MapPin size={13} className="text-text-tertiary" /> {ev.location}
              </div>
            )}
            {ev.conference_url && (
              <a
                href={ev.conference_url}
                onClick={(e) => {
                  e.preventDefault();
                  window.cerebro.shell.openExternal(ev.conference_url!);
                }}
                className="flex items-center gap-1.5 text-accent hover:underline"
              >
                <Video size={13} /> {ev.conference_url}
              </a>
            )}
            {ev.attendees && ev.attendees.length > 0 && (
              <div className="flex items-start gap-1.5">
                <Users size={13} className="mt-0.5 text-text-tertiary" />
                <span>{ev.attendees.map((a) => a.name || a.email).join(', ')}</span>
              </div>
            )}
            {ev.description && (
              <p className="text-[12px] text-text-tertiary whitespace-pre-wrap line-clamp-6">
                {ev.description}
              </p>
            )}
            <div className="flex items-center gap-2 pt-1 text-[11px] text-text-tertiary">
              <span>
                {ev.transparency === 'transparent' ? t('calendar.free') : t('calendar.busy')}
              </span>
              {ev.visibility === 'private' && (
                <span className="flex items-center gap-0.5">
                  <Lock size={10} /> {t('calendar.private')}
                </span>
              )}
              {ev.conflict != null && (
                <span className="flex items-center gap-0.5 text-amber-400">
                  <AlertTriangle size={10} /> {t('calendar.conflictBadge')}
                </span>
              )}
            </div>
          </div>

          {/* RSVP row for invites */}
          {isInvite && (
            <div className="flex items-center gap-2 px-4 pb-2">
              <span className="text-[12px] text-text-tertiary">{t('calendar.event.rsvp')}:</span>
              <RsvpButton
                label={t('calendar.event.rsvpYes')}
                active={ev.rsvp_status === 'accepted'}
                onClick={() => doRsvp('accepted')}
                disabled={busy}
              />
              <RsvpButton
                label={t('calendar.event.rsvpMaybe')}
                active={ev.rsvp_status === 'tentative'}
                onClick={() => doRsvp('tentative')}
                disabled={busy}
              />
              <RsvpButton
                label={t('calendar.event.rsvpNo')}
                active={ev.rsvp_status === 'declined'}
                onClick={() => doRsvp('declined')}
                disabled={busy}
              />
            </div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-4 py-2.5">
            {canEdit && (
              <>
                <button
                  onClick={() => setConfirmDelete(true)}
                  disabled={busy}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                >
                  <Trash2 size={13} /> {t('calendar.event.delete')}
                </button>
                <button
                  onClick={onEdit}
                  disabled={busy}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-50"
                >
                  <Pencil size={13} /> {t('calendar.event.edit')}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {confirmDelete && (
        <AlertModal
          iconTone="danger"
          icon={<Trash2 size={16} className="text-red-400" />}
          title={t('calendar.event.delete')}
          message={t('calendar.event.deleteConfirm')}
          onClose={() => setConfirmDelete(false)}
          actions={[
            { label: t('calendar.event.cancel'), onClick: () => setConfirmDelete(false) },
            {
              label: t('calendar.event.delete'),
              primary: true,
              variant: 'danger',
              onClick: () => void doDelete(),
            },
          ]}
        />
      )}
    </>
  );
}

function RsvpButton({
  label,
  active,
  onClick,
  disabled,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={
        'px-2 py-0.5 rounded text-[12px] disabled:opacity-50 ' +
        (active ? 'bg-accent text-black' : 'bg-bg-surface text-text-secondary hover:bg-bg-hover')
      }
    >
      {label}
    </button>
  );
}
