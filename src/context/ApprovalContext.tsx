import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import type { ApprovalRequest, ApprovalListResponse } from '../types/approvals';

// ── Context types ───────────────────────────────────────────────

interface ApprovalContextValue {
  pendingApprovals: ApprovalRequest[];
  pendingCount: number;
  approve: (id: string) => Promise<void>;
  deny: (id: string, reason?: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const ApprovalContext = createContext<ApprovalContextValue | null>(null);

// ── Provider ────────────────────────────────────────────────────

export function ApprovalProvider({ children }: { children: ReactNode }) {
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);

  // Debounce concurrent refresh calls (event listener + manual refresh can race)
  const refreshInFlight = useRef(false);
  const refreshQueued = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) {
      refreshQueued.current = true;
      return;
    }
    refreshInFlight.current = true;
    try {
      const res = await window.cerebro.invoke<ApprovalListResponse>({
        method: 'GET',
        path: '/engine/approvals?status=pending&limit=100',
      });
      if (res.ok && res.data?.approvals) {
        setPendingApprovals(res.data.approvals);
      }
    } catch {
      // Silently fail — backend may not be ready yet
    } finally {
      refreshInFlight.current = false;
      if (refreshQueued.current) {
        refreshQueued.current = false;
        // Drain the queue with a microtask delay to avoid stack buildup
        queueMicrotask(() => void refresh());
      }
    }
  }, []);

  const approve = useCallback(async (id: string) => {
    const result = await window.cerebro.engine.approve(id);
    if (!result) throw new Error('Approval failed — run may have ended');
    await refresh();
  }, [refresh]);

  const deny = useCallback(async (id: string, reason?: string) => {
    const result = await window.cerebro.engine.deny(id, reason);
    if (!result) throw new Error('Denial failed — run may have ended');
    await refresh();
  }, [refresh]);

  // Initial fetch
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Listen for approval events to auto-refresh
  useEffect(() => {
    const unsubscribe = window.cerebro.engine.onAnyEvent((event) => {
      if (
        event.type === 'approval_requested' ||
        event.type === 'approval_granted' ||
        event.type === 'approval_denied'
      ) {
        refresh();
      }
    });
    return unsubscribe;
  }, [refresh]);

  const value: ApprovalContextValue = {
    pendingApprovals,
    pendingCount: pendingApprovals.length,
    approve,
    deny,
    refresh,
  };

  return (
    <ApprovalContext.Provider value={value}>
      {children}
    </ApprovalContext.Provider>
  );
}

// ── Hook ────────────────────────────────────────────────────────

export function useApprovals(): ApprovalContextValue {
  const ctx = useContext(ApprovalContext);
  if (!ctx) throw new Error('useApprovals must be used within ApprovalProvider');
  return ctx;
}
