/**
 * Connected-calendars management UI (Integrations → Calendar).
 * Lists each connected Google/Outlook account with status, visible-calendar
 * toggles, and reconnect / disconnect. "Add account" opens the OAuth flow.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, RefreshCw, Trash2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import clsx from 'clsx';
import { GoogleCalendarIcon, OutlookIcon } from '../../icons/BrandIcons';
import type { CalendarAccountInfo } from '../../../types/calendar';
import CalendarConnectModal from './CalendarConnectModal';
import Checkbox from '../../ui/Checkbox';
import AlertModal from '../../ui/AlertModal';

function statusPill(status: CalendarAccountInfo['status'], t: (k: string) => string) {
  const map: Record<CalendarAccountInfo['status'], { cls: string; label: string }> = {
    connected: { cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400', label: t('calendar.status.connected') },
    token_expired: { cls: 'border-amber-500/30 bg-amber-500/10 text-amber-400', label: t('calendar.status.tokenExpired') },
    error: { cls: 'border-red-500/30 bg-red-500/10 text-red-400', label: t('calendar.status.error') },
    disconnected: { cls: 'border-border-subtle bg-bg-surface text-text-tertiary', label: t('calendar.status.disconnected') },
  };
  const { cls, label } = map[status];
  return (
    <span className={clsx('text-[10px] font-medium px-2 py-0.5 rounded-full border flex items-center gap-1', cls)}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" /> {label}
    </span>
  );
}

export default function CalendarSection() {
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState<CalendarAccountInfo[]>([]);
  const [showConnect, setShowConnect] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDisconnect, setPendingDisconnect] = useState<CalendarAccountInfo | null>(null);

  const refresh = useCallback(async () => {
    const status = await window.cerebro.calendar.status();
    setAccounts(status.accounts);
  }, []);

  useEffect(() => {
    void refresh();
    const off = window.cerebro.calendar.onEventsChanged(() => void refresh());
    const id = setInterval(refresh, 15_000);
    return () => {
      off();
      clearInterval(id);
    };
  }, [refresh]);

  const reconnect = async (id: string) => {
    setBusyId(id);
    await window.cerebro.calendar.reconnect(id);
    setBusyId(null);
    void refresh();
  };

  const disconnect = async (acc: CalendarAccountInfo) => {
    setPendingDisconnect(null);
    setBusyId(acc.id);
    await window.cerebro.calendar.disconnect(acc.id);
    setBusyId(null);
    void refresh();
  };

  const toggleCalendar = async (acc: CalendarAccountInfo, calId: string, on: boolean) => {
    const selected = (acc.calendars ?? [])
      .filter((c) => (c.id === calId ? on : c.selected !== false))
      .map((c) => c.id);
    await window.cerebro.calendar.setCalendars(acc.id, selected);
    void refresh();
  };

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-text-secondary">{t('calendar.section.description')}</p>

      {accounts.map((acc) => (
        <div key={acc.id} className="rounded-lg border border-border-subtle bg-bg-surface/40 p-3">
          <div className="flex items-center gap-2.5">
            {acc.provider === 'google' ? <GoogleCalendarIcon size={18} /> : <OutlookIcon size={18} />}
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium text-text-primary truncate">{acc.email}</div>
              <div className="text-[11px] text-text-tertiary">
                {acc.last_synced_at
                  ? t('calendar.lastSynced').replace('{{time}}', timeAgo(acc.last_synced_at))
                  : t('calendar.syncedJustNow')}
              </div>
            </div>
            {statusPill(acc.status, t)}
          </div>

          {acc.last_error && acc.status !== 'connected' && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-400">
              <AlertTriangle size={12} /> {acc.last_error}
            </div>
          )}

          {/* Visible calendars */}
          {acc.calendars && acc.calendars.length > 0 && (
            <div className="mt-3">
              <div className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1.5">
                {t('calendar.section.calendarsHeading')}
              </div>
              <div className="space-y-1">
                {acc.calendars.map((c) => (
                  <Checkbox
                    key={c.id}
                    checked={c.selected !== false}
                    onChange={(v) => void toggleCalendar(acc, c.id, v)}
                    label={
                      <span className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full" style={{ background: c.color ?? '#06B6D4' }} />
                        {c.name}
                      </span>
                    }
                  />
                ))}
              </div>
            </div>
          )}

          <div className="mt-3 flex items-center gap-2">
            {acc.status !== 'connected' && (
              <button
                onClick={() => void reconnect(acc.id)}
                disabled={busyId === acc.id}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-50"
              >
                <RefreshCw size={11} /> {t('calendar.section.reconnect')}
              </button>
            )}
            <button
              onClick={() => setPendingDisconnect(acc)}
              disabled={busyId === acc.id}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] text-red-400 hover:bg-red-500/10 disabled:opacity-50"
            >
              <Trash2 size={11} /> {t('calendar.section.disconnect')}
            </button>
          </div>
        </div>
      ))}

      <button
        onClick={() => setShowConnect(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] bg-accent/15 text-accent hover:bg-accent/25"
      >
        <Plus size={13} /> {t('calendar.section.addAccount')}
      </button>

      {accounts.length === 0 && (
        <div className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
          <CheckCircle2 size={12} /> {t('calendar.noAccountsHint')}
        </div>
      )}

      {showConnect && (
        <CalendarConnectModal onClose={() => { setShowConnect(false); void refresh(); }} onPersisted={() => void refresh()} />
      )}

      {pendingDisconnect && (
        <AlertModal
          iconTone="danger"
          icon={<Trash2 size={16} className="text-red-400" />}
          title={t('calendar.section.disconnect')}
          message={t('calendar.section.disconnectConfirm').replace('{{email}}', pendingDisconnect.email)}
          onClose={() => setPendingDisconnect(null)}
          actions={[
            { label: t('calendar.event.cancel'), onClick: () => setPendingDisconnect(null) },
            { label: t('calendar.section.disconnect'), primary: true, variant: 'danger', onClick: () => void disconnect(pendingDisconnect) },
          ]}
        />
      )}
    </div>
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}
