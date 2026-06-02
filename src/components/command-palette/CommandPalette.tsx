/**
 * Superhuman-style command bar (Cmd/Ctrl+K). Offers fast static commands and a
 * natural-language path: free text is parsed by Claude Code into a calendar
 * action, shown as a one-line confirmation, then dispatched on Enter/Run.
 *
 * The explicit confirmation step is the human gate for externally-visible
 * actions (creating/moving/deleting events notifies attendees).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, CornerDownLeft, Loader2, CalendarDays, RefreshCw, Plus, Plug, Clock } from 'lucide-react';
import clsx from 'clsx';
import { useChat } from '../../context/ChatContext';
import { useCalendar } from '../../context/CalendarContext';
import type { CalendarEventInput, CalendarParsedCommand, RsvpResponse } from '../../types/calendar';

interface StaticCommand {
  id: string;
  labelKey: string;
  icon: typeof CalendarDays;
  run: () => void;
}

type ParseState =
  | { kind: 'idle' }
  | { kind: 'parsing' }
  | { kind: 'parsed'; command: CalendarParsedCommand }
  | { kind: 'running' }
  | { kind: 'error'; message: string };

export default function CommandPalette() {
  const { t } = useTranslation();
  const { setActiveScreen } = useChat();
  const cal = useCalendar();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [parse, setParse] = useState<ParseState>({ kind: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setParse({ kind: 'idle' });
  }, []);

  // Global Cmd/Ctrl+K toggle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape' && open) {
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const staticCommands: StaticCommand[] = useMemo(
    () => [
      { id: 'today', labelKey: 'calendar.palette.goToday', icon: CalendarDays, run: () => { setActiveScreen('calendar'); cal.goToday(); } },
      { id: 'week', labelKey: 'calendar.palette.weekView', icon: CalendarDays, run: () => { setActiveScreen('calendar'); cal.setViewMode('week'); } },
      { id: 'day', labelKey: 'calendar.palette.dayView', icon: CalendarDays, run: () => { setActiveScreen('calendar'); cal.setViewMode('day'); } },
      { id: 'refresh', labelKey: 'calendar.palette.refresh', icon: RefreshCw, run: () => { setActiveScreen('calendar'); void cal.refresh(); } },
      { id: 'new', labelKey: 'calendar.palette.newEvent', icon: Plus, run: () => setActiveScreen('calendar') },
      { id: 'connect', labelKey: 'calendar.palette.connect', icon: Plug, run: () => setActiveScreen('calendar') },
    ],
    [cal, setActiveScreen],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return staticCommands;
    return staticCommands.filter((c) => t(c.labelKey).toLowerCase().includes(q));
  }, [query, staticCommands, t]);

  const runStatic = (cmd: StaticCommand) => {
    cmd.run();
    close();
  };

  const submitNL = async () => {
    const text = query.trim();
    if (!text) return;
    setParse({ kind: 'parsing' });
    const res = await window.cerebro.calendar.parseCommand(text);
    if (res.ok && res.command) {
      setParse({ kind: 'parsed', command: res.command });
    } else {
      setParse({ kind: 'error', message: res.error === 'noMatch' ? t('calendar.palette.noMatch') : res.error ?? t('calendar.palette.noMatch') });
    }
  };

  const dispatch = async (command: CalendarParsedCommand) => {
    setParse({ kind: 'running' });
    const p = command.params as Record<string, unknown>;
    try {
      switch (command.action) {
        case 'calendar_create_event':
          await cal.createEvent(toEventInput(p));
          break;
        case 'calendar_update_event':
          await cal.updateEvent(String(p.event_id ?? ''), toEventPatch(p));
          break;
        case 'calendar_delete_event':
          await cal.deleteEvent(String(p.event_id ?? ''));
          break;
        case 'calendar_rsvp':
          await cal.rsvp(String(p.event_id ?? ''), String(p.response ?? 'accepted') as RsvpResponse);
          break;
        default:
          // Read-only actions (query/find_free_time): just take the user to the calendar.
          break;
      }
      setActiveScreen('calendar');
      close();
    } catch (err) {
      setParse({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (parse.kind === 'parsed') {
        void dispatch(parse.command);
      } else if (filtered.length === 1 && query.trim()) {
        runStatic(filtered[0]);
      } else {
        void submitNL();
      }
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh] bg-black/40" onClick={close}>
      <div
        className="w-[560px] max-w-[92vw] rounded-xl border border-border-subtle bg-bg-base shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3.5 py-3 border-b border-border-subtle">
          {parse.kind === 'parsing' || parse.kind === 'running' ? (
            <Loader2 size={16} className="text-accent animate-spin" />
          ) : (
            <Search size={16} className="text-text-tertiary" />
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); if (parse.kind !== 'idle') setParse({ kind: 'idle' }); }}
            onKeyDown={onInputKeyDown}
            placeholder={t('calendar.palette.placeholder')}
            className="flex-1 bg-transparent text-[14px] text-text-primary outline-none placeholder:text-text-tertiary"
          />
          <kbd className="text-[10px] text-text-tertiary border border-border-subtle rounded px-1.5 py-0.5">esc</kbd>
        </div>

        <div className="max-h-[320px] overflow-y-auto scrollbar-thin py-1.5">
          {/* Parsed NL confirmation */}
          {parse.kind === 'parsed' && (
            <div className="px-3.5 py-2">
              <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2.5">
                <div className="flex items-center gap-2 text-[12px] text-accent mb-1">
                  <Clock size={13} /> {parse.command.action.replace('calendar_', '').replace(/_/g, ' ')}
                </div>
                <p className="text-[13px] text-text-primary">{parse.command.summary || t('calendar.palette.run')}</p>
                <button
                  onClick={() => void dispatch(parse.command)}
                  className="mt-2 flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] bg-accent text-black font-medium hover:brightness-110"
                >
                  <CornerDownLeft size={12} /> {t('calendar.palette.run')}
                </button>
              </div>
            </div>
          )}

          {parse.kind === 'error' && (
            <div className="px-3.5 py-2 text-[12px] text-red-400">{parse.message}</div>
          )}

          {parse.kind === 'parsing' && (
            <div className="px-3.5 py-2 text-[12px] text-text-tertiary">{t('calendar.palette.parsing')}</div>
          )}

          {/* Static commands */}
          {(parse.kind === 'idle' || parse.kind === 'error') && filtered.map((cmd) => {
            const Icon = cmd.icon;
            return (
              <button
                key={cmd.id}
                onClick={() => runStatic(cmd)}
                className="w-full flex items-center gap-2.5 px-3.5 py-2 text-left text-[13px] text-text-secondary hover:bg-bg-hover"
              >
                <Icon size={14} className="text-text-tertiary" />
                {t(cmd.labelKey)}
              </button>
            );
          })}

          {/* NL hint */}
          {parse.kind === 'idle' && (
            <div className="px-3.5 pt-2 pb-1 text-[11px] text-text-tertiary border-t border-border-subtle mt-1">
              {t('calendar.palette.hint')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function toEventInput(p: Record<string, unknown>): CalendarEventInput {
  return {
    title: String(p.title ?? 'Untitled'),
    start: String(p.start ?? ''),
    end: String(p.end ?? ''),
    tz: p.tz ? String(p.tz) : undefined,
    all_day: Boolean(p.all_day),
    location: p.location ? String(p.location) : undefined,
    description: p.description ? String(p.description) : undefined,
    attendees: Array.isArray(p.attendees) ? (p.attendees as unknown[]).map(String) : undefined,
    busy: p.busy === undefined ? undefined : Boolean(p.busy),
    conference: Boolean(p.conference),
  };
}

function toEventPatch(p: Record<string, unknown>): Partial<CalendarEventInput> {
  const patch: Partial<CalendarEventInput> = {};
  if (p.title) patch.title = String(p.title);
  if (p.start) patch.start = String(p.start);
  if (p.end) patch.end = String(p.end);
  if (p.tz) patch.tz = String(p.tz);
  if (p.location) patch.location = String(p.location);
  if (p.busy !== undefined) patch.busy = Boolean(p.busy);
  return patch;
}
