/**
 * Unified calendar screen — keyboard-first day/week views across all connected
 * accounts, with a manual Refresh and inline connect flow.
 *
 * Shortcuts: t=today, w=week, d=day, c=create, ←/→ navigate, r=refresh.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Plus,
  Plug,
  AlertTriangle,
  Sparkles,
  X,
  Loader2,
} from 'lucide-react';
import clsx from 'clsx';
import { useCalendar } from '../../../context/CalendarContext';
import type { CalendarOccurrence } from '../../../calendar/recurrence';
import type { CalendarEventDTO } from '../../../types/calendar';
import CalendarTimeGrid from './CalendarTimeGrid';
import CalendarMonthView from './CalendarMonthView';
import EventDetailPopover from './EventDetailPopover';
import EventEditModal from './EventEditModal';
import { roundedNow } from '../../../calendar/cal-utils';

const CalendarConnectModal = lazy(() => import('../integrations/CalendarConnectModal'));

export default function CalendarScreen() {
  const { t } = useTranslation();
  const cal = useCalendar();
  const [selected, setSelected] = useState<CalendarOccurrence | null>(null);
  const [editing, setEditing] = useState<{
    event?: CalendarEventDTO;
    start?: Date;
    end?: Date;
  } | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [ai, setAi] = useState<{
    loading: boolean;
    text: string | null;
    error: string | null;
  } | null>(null);

  const askAi = useCallback(async () => {
    setAi({ loading: true, text: null, error: null });
    const res = await window.cerebro.calendar.aiSummary({
      range: cal.viewMode,
      startISO: cal.windowStart.toISOString(),
    });
    setAi({
      loading: false,
      text: res.ok ? (res.text ?? '') : null,
      error: res.ok ? null : (res.error ?? 'error'),
    });
  }, [cal.viewMode, cal.windowStart]);

  const days = useMemo(() => {
    const out: Date[] = [];
    const n = cal.viewMode === 'week' ? 7 : 1;
    for (let i = 0; i < n; i += 1) {
      const d = new Date(cal.windowStart);
      d.setDate(d.getDate() + i);
      out.push(d);
    }
    return out;
  }, [cal.viewMode, cal.windowStart]);

  const expiredAccounts = cal.accounts.filter((a) => a.status === 'token_expired');
  const erroredAccounts = cal.accounts.filter((a) => a.status === 'error');

  // Keyboard shortcuts (ignored while typing in an input or a modal is open).
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (selected || editing || connectOpen) return;
      switch (e.key) {
        case 't':
          cal.goToday();
          break;
        case 'w':
          cal.setViewMode('week');
          break;
        case 'd':
          cal.setViewMode('day');
          break;
        case 'r':
          void cal.refresh();
          break;
        case 'c':
          setEditing({ start: roundedNow() });
          break;
        case 'ArrowLeft':
          cal.goPrev();
          break;
        case 'ArrowRight':
          cal.goNext();
          break;
      }
    },
    [cal, selected, editing, connectOpen],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  const rangeLabel = useMemo(() => {
    if (cal.viewMode === 'month') {
      return cal.anchorDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    }
    if (cal.viewMode === 'day') {
      return cal.anchorDate.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      });
    }
    const last = new Date(cal.windowStart);
    last.setDate(last.getDate() + 6);
    const sameMonth = last.getMonth() === cal.windowStart.getMonth();
    const startStr = cal.windowStart.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
    const endStr = last.toLocaleDateString(
      undefined,
      sameMonth
        ? { day: 'numeric', year: 'numeric' }
        : { month: 'short', day: 'numeric', year: 'numeric' },
    );
    return `${startStr} – ${endStr}`;
  }, [cal.viewMode, cal.anchorDate, cal.windowStart]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 pt-5 pb-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-accent/10 flex items-center justify-center">
            <CalendarDays className="text-accent" size={18} />
          </div>
          <div className="flex-1">
            <h1 className="text-[18px] font-semibold text-text-primary leading-tight">
              {t('calendar.title')}
            </h1>
            <p className="text-[12px] text-text-tertiary">{rangeLabel}</p>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={cal.goToday}
              className="px-2.5 py-1 rounded-md text-[12px] text-text-secondary hover:bg-bg-hover"
            >
              {t('calendar.today')}
            </button>
            <button
              onClick={cal.goPrev}
              className="p-1 rounded-md text-text-secondary hover:bg-bg-hover"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={cal.goNext}
              className="p-1 rounded-md text-text-secondary hover:bg-bg-hover"
            >
              <ChevronRight size={16} />
            </button>

            <div className="mx-1 flex rounded-md border border-border-subtle overflow-hidden">
              {(['day', 'week', 'month'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => cal.setViewMode(m)}
                  className={clsx(
                    'px-2.5 py-1 text-[12px]',
                    cal.viewMode === m
                      ? 'bg-accent/15 text-accent'
                      : 'text-text-secondary hover:bg-bg-hover',
                  )}
                >
                  {t(`calendar.views.${m}`)}
                </button>
              ))}
            </div>

            <button
              onClick={() => void cal.refresh()}
              disabled={cal.syncing}
              title={t('calendar.refresh')}
              className="p-1.5 rounded-md text-text-secondary hover:bg-bg-hover disabled:opacity-50"
            >
              <RefreshCw size={15} className={cal.syncing ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={() => setConnectOpen(true)}
              title={t('calendar.connect')}
              className="p-1.5 rounded-md text-text-secondary hover:bg-bg-hover"
            >
              <Plug size={15} />
            </button>
            <button
              onClick={() => void askAi()}
              title={t('calendar.ai.weekSummary')}
              className="p-1.5 rounded-md text-text-secondary hover:bg-bg-hover"
            >
              <Sparkles size={15} />
            </button>
            <button
              onClick={() => setEditing({ start: roundedNow() })}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] bg-accent text-black font-medium hover:brightness-110"
            >
              <Plus size={13} /> {t('calendar.newEvent')}
            </button>
          </div>
        </div>

        {/* Account error banners */}
        {expiredAccounts.map((a) => (
          <Banner
            key={a.id}
            tone="warn"
            text={t('calendar.errors.tokenExpired', { email: a.email })}
          />
        ))}
        {erroredAccounts.map((a) => (
          <Banner
            key={a.id}
            tone="error"
            text={t('calendar.errors.syncFailed', { email: a.email, error: a.last_error ?? '' })}
          />
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 px-6 pb-6">
        <div className="h-full rounded-xl border border-border-subtle bg-bg-surface/30 overflow-hidden">
          {/* The grid is always available — the built-in local calendar works
              without connecting any provider. */}
          {cal.viewMode === 'month' ? (
            <CalendarMonthView
              windowStart={cal.windowStart}
              anchorDate={cal.anchorDate}
              events={cal.events}
              accounts={cal.accounts}
              onSelectEvent={(occ) => setSelected(occ)}
              onPickDay={(day) => {
                cal.goToDate(day);
                cal.setViewMode('day');
              }}
              onCreateAt={(start) => setEditing({ start })}
            />
          ) : (
            <CalendarTimeGrid
              days={days}
              events={cal.events}
              accounts={cal.accounts}
              onSelectEvent={(occ) => setSelected(occ)}
              onCreateAt={(start, end) => setEditing({ start, end })}
            />
          )}
        </div>
      </div>

      {selected && (
        <EventDetailPopover
          occurrence={selected}
          onClose={() => setSelected(null)}
          onEdit={() => {
            setEditing({ event: selected.event });
            setSelected(null);
          }}
        />
      )}

      {editing && (
        <EventEditModal
          event={editing.event}
          initialStart={editing.start}
          initialEnd={editing.end}
          onClose={() => setEditing(null)}
        />
      )}

      {connectOpen && (
        <Suspense fallback={null}>
          <CalendarConnectModal
            onClose={() => setConnectOpen(false)}
            onPersisted={() => void cal.reloadAccounts()}
          />
        </Suspense>
      )}

      {ai && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setAi(null)}
        >
          <div
            className="w-[480px] max-w-[92vw] rounded-xl border border-border-subtle bg-bg-base shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
              <Sparkles size={15} className="text-accent" />
              <h2 className="flex-1 text-[14px] font-semibold text-text-primary">
                {t('calendar.ai.weekSummary')}
              </h2>
              <button
                onClick={() => setAi(null)}
                className="text-text-tertiary hover:text-text-secondary"
              >
                <X size={16} />
              </button>
            </div>
            <div className="px-4 py-4 text-[13px] text-text-secondary max-h-[60vh] overflow-y-auto scrollbar-thin whitespace-pre-wrap">
              {ai.loading && (
                <div className="flex items-center gap-2 text-text-tertiary">
                  <Loader2 size={15} className="animate-spin" /> {t('calendar.ai.thinking')}
                </div>
              )}
              {ai.error && <span className="text-red-400">{t('calendar.ai.error')}</span>}
              {ai.text && <p>{ai.text}</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Banner({ tone, text }: { tone: 'warn' | 'error'; text: string }) {
  return (
    <div
      className={clsx(
        'mt-2 flex items-center gap-2 px-3 py-1.5 rounded-md text-[12px]',
        tone === 'warn' ? 'bg-amber-500/10 text-amber-400' : 'bg-red-500/10 text-red-400',
      )}
    >
      <AlertTriangle size={13} /> {text}
    </div>
  );
}
