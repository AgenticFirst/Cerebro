import { useState } from 'react';
import { Zap, CheckCircle, XCircle, Loader2, ChevronDown, ChevronRight, Clock } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import type { ApprovalRequest } from '../../../types/approvals';
import { timeAgo } from '../activity/helpers';

// ── JSON Parameters section ─────────────────────────────────────

function ParametersSection({ json }: { json: string | null }) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  if (!json) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  const isEmpty = typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length === 0;
  if (isEmpty) return null;

  return (
    <div className="mt-3">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer"
      >
        {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {t('approvals.parameters')}
      </button>
      {isOpen && (
        <pre className="mt-1.5 p-2.5 rounded-lg bg-black/20 border border-white/[0.04] text-[11px] text-text-secondary font-mono overflow-x-auto max-h-48">
          {JSON.stringify(parsed, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ── Status badge for history ────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const config: Record<string, { bg: string; text: string; label: string }> = {
    approved: { bg: 'bg-green-500/15', text: 'text-green-400', label: t('status.approved') },
    denied: { bg: 'bg-red-500/15', text: 'text-red-400', label: t('status.denied') },
    expired: { bg: 'bg-zinc-500/15', text: 'text-zinc-400', label: t('status.expired') },
  };
  const c = config[status] ?? config.expired;

  return (
    <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium', c.bg, c.text)}>
      {status === 'approved' && <CheckCircle size={11} />}
      {status === 'denied' && <XCircle size={11} />}
      {status === 'expired' && <Clock size={11} />}
      {c.label}
    </span>
  );
}

// ── Main card ───────────────────────────────────────────────────

interface ApprovalCardProps {
  approval: ApprovalRequest;
  variant: 'pending' | 'history';
  onApprove?: (id: string) => Promise<void>;
  onDeny?: (id: string, reason?: string) => Promise<void>;
}

export default function ApprovalCard({ approval, variant, onApprove, onDeny }: ApprovalCardProps) {
  const { t } = useTranslation();
  const [isApproving, setIsApproving] = useState(false);
  const [isDenying, setIsDenying] = useState(false);
  const [showDenyForm, setShowDenyForm] = useState(false);
  const [denyReason, setDenyReason] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const handleApprove = async () => {
    if (!onApprove) return;
    setIsApproving(true);
    setActionError(null);
    try {
      await onApprove(approval.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Approval failed');
    } finally {
      setIsApproving(false);
    }
  };

  const handleDeny = async () => {
    if (!onDeny) return;
    setIsDenying(true);
    setActionError(null);
    try {
      await onDeny(approval.id, denyReason || undefined);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Denial failed');
    } finally {
      setIsDenying(false);
      setShowDenyForm(false);
      setDenyReason('');
    }
  };

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-xl p-5">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className={clsx(
          'flex items-center justify-center w-8 h-8 rounded-lg flex-shrink-0 mt-0.5',
          variant === 'pending'
            ? 'bg-amber-500/15 text-amber-400'
            : 'bg-zinc-500/10 text-text-tertiary',
        )}>
          <Zap size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-[14px] font-semibold text-text-primary truncate">
            {approval.step_name}
          </h3>
          {approval.summary && approval.summary !== approval.step_name && (
            <p className="text-[12px] text-text-secondary mt-0.5 line-clamp-2">
              {approval.summary}
            </p>
          )}
          <p className="text-[11px] text-text-tertiary mt-0.5">
            {t('approvals.requested', { time: timeAgo(approval.requested_at, t) })}
          </p>
        </div>
        {variant === 'history' && (
          <StatusBadge status={approval.status} />
        )}
      </div>

      {/* Parameters */}
      <ParametersSection json={approval.payload_json} />

      {/* Decision reason (history only) */}
      {variant === 'history' && approval.decision_reason && (
        <div className="mt-3 text-[12px] text-text-secondary">
          <span className="text-text-tertiary">{t('approvals.reason')}</span>
          {approval.decision_reason}
        </div>
      )}

      {/* Resolved time (history only) */}
      {variant === 'history' && approval.resolved_at && (
        <div className="mt-1 text-[11px] text-text-tertiary">
          {t('approvals.resolved', { time: timeAgo(approval.resolved_at, t) })}
        </div>
      )}

      {/* Error feedback */}
      {actionError && (
        <p className="mt-3 text-[11px] text-red-400">{actionError}</p>
      )}

      {/* Actions (pending only) */}
      {variant === 'pending' && (
        <div className="mt-4">
          {showDenyForm ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={denyReason}
                onChange={(e) => setDenyReason(e.target.value)}
                placeholder={t('approvals.reasonPlaceholder')}
                className="flex-1 px-2.5 py-1.5 rounded-lg bg-black/20 border border-white/[0.06] text-[12px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-red-500/40"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleDeny();
                  if (e.key === 'Escape') { setShowDenyForm(false); setDenyReason(''); }
                }}
                autoFocus
              />
              <button
                onClick={handleDeny}
                disabled={isDenying}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/20 transition-colors cursor-pointer disabled:opacity-50"
              >
                {isDenying ? <Loader2 size={13} className="animate-spin" /> : <XCircle size={13} />}
                {t('approvals.confirm')}
              </button>
              <button
                onClick={() => { setShowDenyForm(false); setDenyReason(''); }}
                className="px-2 py-1.5 rounded-lg text-[12px] text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer"
              >
                {t('common.cancel')}
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setShowDenyForm(true)}
                disabled={isApproving}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-text-secondary hover:text-red-400 hover:bg-red-500/10 border border-white/[0.06] hover:border-red-500/20 transition-colors cursor-pointer disabled:opacity-50"
              >
                <XCircle size={13} />
                {t('approvals.deny')}
              </button>
              <button
                onClick={handleApprove}
                disabled={isApproving || isDenying}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-accent/15 text-accent hover:bg-accent/25 border border-accent/20 transition-colors cursor-pointer disabled:opacity-50"
              >
                {isApproving ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle size={13} />}
                {t('approvals.approve')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
