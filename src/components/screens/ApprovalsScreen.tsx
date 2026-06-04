import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck, Loader2, ShieldOff, Trash2, Hash } from 'lucide-react';
import clsx from 'clsx';
import { useApprovals } from '../../context/ApprovalContext';
import type {
  ApprovalRequest,
  ApprovalListResponse,
  AutoApprovalRule,
  AutoApprovalRuleListResponse,
} from '../../types/approvals';
import ApprovalCard from './approvals/ApprovalCard';

type Tab = 'pending' | 'history' | 'auto';

/** Humanize an auto-approval action type for display, e.g. "Slack message". */
function actionTypeLabel(actionType: string): string {
  switch (actionType) {
    case 'send_slack_message':
      return 'Slack message';
    case 'send_slack_file':
      return 'Slack file';
    default:
      return actionType;
  }
}

export default function ApprovalsScreen() {
  const { t } = useTranslation();
  const { pendingApprovals, approve, deny, refresh } = useApprovals();

  const [activeTab, setActiveTab] = useState<Tab>('pending');
  const [history, setHistory] = useState<ApprovalRequest[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  const [autoRules, setAutoRules] = useState<AutoApprovalRule[]>([]);
  const [isLoadingAuto, setIsLoadingAuto] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const loadAutoRules = useCallback(async () => {
    setIsLoadingAuto(true);
    try {
      const res = await window.cerebro.invoke<AutoApprovalRuleListResponse>({
        method: 'GET',
        path: '/engine/auto-approvals',
      });
      if (res.ok && res.data?.rules) {
        setAutoRules(res.data.rules);
      }
    } catch {
      // ignore
    } finally {
      setIsLoadingAuto(false);
    }
  }, []);

  const revokeAutoRule = useCallback(async (id: string) => {
    setRevokingId(id);
    try {
      const res = await window.cerebro.invoke({
        method: 'DELETE',
        path: `/engine/auto-approvals/${id}`,
      });
      if (res.ok) {
        setAutoRules((prev) => prev.filter((r) => r.id !== id));
      }
    } catch {
      // ignore
    } finally {
      setRevokingId(null);
    }
  }, []);

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

  // Load history / auto-approval rules when switching to those tabs
  useEffect(() => {
    if (activeTab === 'history') {
      loadHistory();
    } else if (activeTab === 'auto') {
      loadAutoRules();
    }
  }, [activeTab, loadHistory, loadAutoRules]);

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
            <h1 className="text-[18px] font-semibold text-text-primary leading-tight">
              {t('approvals.title')}
            </h1>
            <p className="text-[12px] text-text-secondary mt-0.5">{t('approvals.subtitle')}</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-0 border-b border-border-subtle" data-tour-id="approvals-tabs">
          {(['pending', 'history', 'auto'] as Tab[]).map((tab) => (
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
              {tab === 'pending'
                ? pendingApprovals.length > 0
                  ? t('approvals.pendingTabCount', { count: pendingApprovals.length })
                  : t('approvals.pendingTab')
                : tab === 'history'
                  ? t('approvals.historyTab')
                  : t('approvals.autoTab')}
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
              <h2 className="text-[15px] font-medium text-text-secondary mb-1">
                {t('approvals.noPending')}
              </h2>
              <p className="text-[12px] text-text-secondary max-w-xs">
                {t('approvals.noPendingDescription')}
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
        ) : activeTab === 'history' ? (
          isLoadingHistory ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={20} className="animate-spin text-text-tertiary" />
            </div>
          ) : history.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center py-16">
              <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-white/[0.03] mb-4">
                <ShieldCheck size={24} className="text-text-tertiary" />
              </div>
              <h2 className="text-[15px] font-medium text-text-secondary mb-1">
                {t('approvals.noHistory')}
              </h2>
              <p className="text-[12px] text-text-tertiary max-w-xs">
                {t('approvals.noHistoryDescription')}
              </p>
            </div>
          ) : (
            <div className="space-y-3 max-w-2xl">
              {history.map((approval) => (
                <ApprovalCard key={approval.id} approval={approval} variant="history" />
              ))}
            </div>
          )
        ) : isLoadingAuto ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={20} className="animate-spin text-text-tertiary" />
          </div>
        ) : autoRules.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-16">
            <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-white/[0.03] mb-4">
              <ShieldOff size={24} className="text-text-tertiary" />
            </div>
            <h2 className="text-[15px] font-medium text-text-secondary mb-1">
              {t('approvals.noAuto')}
            </h2>
            <p className="text-[12px] text-text-tertiary max-w-xs">
              {t('approvals.noAutoDescription')}
            </p>
          </div>
        ) : (
          <div className="space-y-3 max-w-2xl">
            <p className="text-[12px] text-text-tertiary mb-1">{t('approvals.autoSubtitle')}</p>
            {autoRules.map((rule) => (
              <div
                key={rule.id}
                className="flex items-center gap-3 rounded-xl border border-border-subtle bg-white/[0.02] px-4 py-3"
              >
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-accent/10 flex-shrink-0">
                  <Hash size={15} className="text-accent" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-text-primary truncate">
                    {rule.target_label || rule.target_key}
                  </p>
                  <p className="text-[11px] text-text-tertiary truncate">
                    {actionTypeLabel(rule.action_type)}
                  </p>
                </div>
                <button
                  onClick={() => revokeAutoRule(rule.id)}
                  disabled={revokingId === rule.id}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium text-text-secondary hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
                >
                  {revokingId === rule.id ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Trash2 size={13} />
                  )}
                  {t('approvals.revoke')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
