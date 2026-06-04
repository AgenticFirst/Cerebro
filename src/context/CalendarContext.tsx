/**
 * CalendarContext — renderer-side state for the unified calendar.
 *
 * Reads normalized events straight from the backend store (window.cerebro.invoke
 * → GET /calendar/events) for the visible window, and drives mutations / sync
 * through the main-process bridge (window.cerebro.calendar.*). Re-fetches on the
 * bridge's events-changed signal so a background sync tick updates the grid.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  CalendarAccountInfo,
  CalendarEventDTO,
  CalendarEventInput,
  RsvpResponse,
} from '../types/calendar';
import { startOfDay, startOfWeek } from '../calendar/cal-utils';

export type CalendarViewMode = 'day' | 'week' | 'month';

interface CalendarContextValue {
  accounts: CalendarAccountInfo[];
  connected: boolean;
  events: CalendarEventDTO[];
  loading: boolean;
  syncing: boolean;
  error: string | null;
  viewMode: CalendarViewMode;
  anchorDate: Date;
  /** Inclusive start / exclusive end of the currently fetched window (local). */
  windowStart: Date;
  windowEnd: Date;
  setViewMode: (m: CalendarViewMode) => void;
  goToday: () => void;
  goPrev: () => void;
  goNext: () => void;
  goToDate: (d: Date) => void;
  refresh: () => Promise<void>;
  reloadAccounts: () => Promise<void>;
  createEvent: (input: CalendarEventInput) => Promise<{ ok: boolean; error?: string }>;
  updateEvent: (
    eventId: string,
    patch: Partial<CalendarEventInput>,
  ) => Promise<{ ok: boolean; error?: string }>;
  deleteEvent: (eventId: string) => Promise<{ ok: boolean; error?: string }>;
  rsvp: (eventId: string, response: RsvpResponse) => Promise<{ ok: boolean; error?: string }>;
}

const CalendarContext = createContext<CalendarContextValue | null>(null);

function computeWindow(mode: CalendarViewMode, anchor: Date): { start: Date; end: Date } {
  if (mode === 'day') {
    const start = startOfDay(anchor);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start, end };
  }
  if (mode === 'month') {
    // Full 6-week grid starting on the Monday of the week containing the 1st.
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const start = startOfWeek(first);
    const end = new Date(start);
    end.setDate(end.getDate() + 42);
    return { start, end };
  }
  const start = startOfWeek(anchor);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end };
}

export function CalendarProvider({ children }: { children: ReactNode }) {
  const [accounts, setAccounts] = useState<CalendarAccountInfo[]>([]);
  const [events, setEvents] = useState<CalendarEventDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<CalendarViewMode>('week');
  const [anchorDate, setAnchorDate] = useState<Date>(() => new Date());

  const { start: windowStart, end: windowEnd } = useMemo(
    () => computeWindow(viewMode, anchorDate),
    [viewMode, anchorDate],
  );

  const reqIdRef = useRef(0);

  const fetchEvents = useCallback(async () => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        start: windowStart.toISOString(),
        end: windowEnd.toISOString(),
      });
      const res = await window.cerebro.invoke<{ events: CalendarEventDTO[] }>({
        method: 'GET',
        path: `/calendar/events?${params.toString()}`,
      });
      if (reqId !== reqIdRef.current) return; // a newer request superseded this one
      if (res.ok && res.data) {
        setEvents(res.data.events);
        setError(null);
      }
    } catch {
      if (reqId === reqIdRef.current) setError('loadFailed');
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }, [windowStart, windowEnd]);

  const reloadAccounts = useCallback(async () => {
    try {
      const status = await window.cerebro.calendar.status();
      setAccounts(status.accounts);
    } catch {
      /* status is best-effort */
    }
  }, []);

  // Initial + window-change fetch. `fetchEvents`'s identity already changes
  // whenever the window does (it closes over windowStart/windowEnd).
  useEffect(() => {
    void fetchEvents();
  }, [fetchEvents]);

  useEffect(() => {
    void reloadAccounts();
  }, [reloadAccounts]);

  // Live updates from background sync ticks / mutations.
  useEffect(() => {
    const off = window.cerebro.calendar.onEventsChanged(() => {
      void fetchEvents();
      void reloadAccounts();
    });
    return off;
  }, [fetchEvents, reloadAccounts]);

  const refresh = useCallback(async () => {
    setSyncing(true);
    try {
      await window.cerebro.calendar.syncNow();
      await fetchEvents();
      await reloadAccounts();
    } finally {
      setSyncing(false);
    }
  }, [fetchEvents, reloadAccounts]);

  const goToday = useCallback(() => setAnchorDate(new Date()), []);
  const goToDate = useCallback((d: Date) => setAnchorDate(d), []);
  const step = useCallback(
    (dir: 1 | -1) => {
      setAnchorDate((prev) => {
        const next = new Date(prev);
        if (viewMode === 'month') next.setMonth(next.getMonth() + dir);
        else next.setDate(next.getDate() + dir * (viewMode === 'week' ? 7 : 1));
        return next;
      });
    },
    [viewMode],
  );
  const goPrev = useCallback(() => step(-1), [step]);
  const goNext = useCallback(() => step(1), [step]);

  const createEvent = useCallback(
    async (input: CalendarEventInput) => {
      const r = await window.cerebro.calendar.createEvent(input);
      if (r.ok) await fetchEvents();
      return { ok: r.ok, error: r.error };
    },
    [fetchEvents],
  );
  const updateEvent = useCallback(
    async (eventId: string, patch: Partial<CalendarEventInput>) => {
      const r = await window.cerebro.calendar.updateEvent(eventId, patch);
      if (r.ok) await fetchEvents();
      return { ok: r.ok, error: r.error };
    },
    [fetchEvents],
  );
  const deleteEvent = useCallback(
    async (eventId: string) => {
      const r = await window.cerebro.calendar.deleteEvent(eventId);
      if (r.ok) await fetchEvents();
      return r;
    },
    [fetchEvents],
  );
  const rsvp = useCallback(
    async (eventId: string, response: RsvpResponse) => {
      const r = await window.cerebro.calendar.rsvp(eventId, response);
      if (r.ok) await fetchEvents();
      return r;
    },
    [fetchEvents],
  );

  const value: CalendarContextValue = {
    accounts,
    connected: accounts.some((a) => a.status === 'connected'),
    events,
    loading,
    syncing,
    error,
    viewMode,
    anchorDate,
    windowStart,
    windowEnd,
    setViewMode,
    goToday,
    goPrev,
    goNext,
    goToDate,
    refresh,
    reloadAccounts,
    createEvent,
    updateEvent,
    deleteEvent,
    rsvp,
  };

  return <CalendarContext.Provider value={value}>{children}</CalendarContext.Provider>;
}

export function useCalendar(): CalendarContextValue {
  const ctx = useContext(CalendarContext);
  if (!ctx) throw new Error('useCalendar must be used within a CalendarProvider');
  return ctx;
}
