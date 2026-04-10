import { useEffect, useState, useCallback, useRef } from 'react';
import { ShieldCheck, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { useApprovals } from '../../context/ApprovalContext';
import type { ApprovalRequest, ApprovalListResponse } from '../../types/approvals';
import ApprovalCard from './approvals/ApprovalCard';

type Tab = 'pending' | 'history';

export default function ApprovalsScreen() {
  const { pendingApprovals, approve, deny, refresh } = useApprovals();

  const [activeTab, setActiveTab] = useState<Tab>('pending');
  const [history, setHistory] = useState<ApprovalRequest[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  const loadHistory = useCallback(async () => {
    setIsLoadingHistory(true);
    try {
      const res = await window.cerebro.invoke<ApprovalListResponse>({
        method: 'GET',
        path: '/engine/approvals?limit=100',
      });
      if (res.ok && res.data?.approvals) {
        setHistory(res.data.approvals.filter((a) => a.status !== 'pending'));
      }
    } catch {
      // ignore
    } finally {
      setIsLoadingHistory(false);
    }
  }, []);

  // Load history when switching to that tab
  useEffect(() => {
    if (activeTab === 'history') {
      loadHistory();
    }
  }, [activeTab, loadHistory]);

  // Refresh pending on mount
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh history when approval events fire while on the history tab
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  useEffect(() => {
    const unsubscribe = window.cerebro.engine.onAnyEvent((event) => {
      if (
        activeTabRef.current === 'history' &&
        (event.type === 'approval_granted' || event.type === 'approval_denied')
      ) {
        loadHistory();
      }
    });
    return unsubscribe;
  }, [loadHistory]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex-shrink-0 px-6 pt-5 pb-0">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-accent/10">
            <ShieldCheck size={18} className="text-accent" />
          </div>
          <div>
            <h1 className="text-[18px] font-semibold text-text-primary leading-tight">Approvals</h1>
            <p className="text-[12px] text-text-secondary mt-0.5">Review and approve pending actions</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-0 border-b border-border-subtle">
          {(['pending', 'history'] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={clsx(
                'px-4 py-2 text-[13px] font-medium border-b-2 -mb-px transition-colors cursor-pointer',
                activeTab === tab
                  ? 'text-accent border-accent'
                  : 'text-text-tertiary border-transparent hover:text-text-secondary',
              )}
            >
              {tab === 'pending' ? `Pending${pendingApprovals.length > 0 ? ` (${pendingApprovals.length})` : ''}` : 'History'}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-6 py-4">
        {activeTab === 'pending' ? (
          pendingApprovals.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center py-16">
              <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-white/[0.03] mb-4">
                <ShieldCheck size={24} className="text-text-tertiary" />
              </div>
              <h2 className="text-[15px] font-medium text-text-secondary mb-1">No pending approvals</h2>
              <p className="text-[12px] text-text-secondary max-w-xs">
                When a routine step requires your sign-off, it will appear here.
              </p>
            </div>
          ) : (
            <div className="space-y-3 max-w-2xl">
              {pendingApprovals.map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  variant="pending"
                  onApprove={approve}
                  onDeny={deny}
                />
              ))}
            </div>
          )
        ) : (
          isLoadingHistory ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={20} className="animate-spin text-text-tertiary" />
            </div>
          ) : history.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center py-16">
              <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-white/[0.03] mb-4">
                <ShieldCheck size={24} className="text-text-tertiary" />
              </div>
              <h2 className="text-[15px] font-medium text-text-secondary mb-1">No approval history yet</h2>
              <p className="text-[12px] text-text-tertiary max-w-xs">
                Resolved approvals will appear here.
              </p>
            </div>
          ) : (
            <div className="space-y-3 max-w-2xl">
              {history.map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  variant="history"
                />
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}
