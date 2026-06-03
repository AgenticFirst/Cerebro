import { useEffect, useState, useCallback } from 'react';
import {
  RefreshCw,
  Upload,
  Phone,
  Target,
  CheckCircle2,
} from 'lucide-react';
import clsx from 'clsx';

/* ── Types ──────────────────────────────────────────────────── */

interface IMDAudit {
  id: string;
  business_name: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  instagram: string | null;
  city: string | null;
  industry: string;
  language: string;
  ghl_contact_id: string | null;
  d1: number | null;
  d2: number | null;
  d3: number | null;
  d4: number | null;
  d5: number | null;
  d6: number | null;
  total: number | null;
  classification: string | null;
  pipeline_stage: string;
  d6_call_outcome: string | null;
  d5_hours_to_respond: number | null;
  created_at: string;
}

interface AuditStats {
  total: number;
  lider: number;
  avanzado: number;
  intermedio: number;
  basico: number;
}

type IndustryFilter = 'all' | 'aesthetic-medicine' | 'dental' | 'legal';
type ClassificationFilter = 'all' | 'Líder' | 'Avanzado' | 'Intermedio' | 'Básico';

/* ── Helpers ────────────────────────────────────────────────── */

function scoreColor(val: number | null): string {
  if (val === null) return 'text-text-tertiary';
  if (val >= 15) return 'text-green-400';
  if (val >= 10) return 'text-yellow-400';
  return 'text-red-400';
}

function classificationBadgeClass(cls: string | null): string {
  switch (cls) {
    case 'Líder':
      return 'bg-blue-500/20 text-blue-400';
    case 'Avanzado':
      return 'bg-green-500/20 text-green-400';
    case 'Intermedio':
      return 'bg-yellow-500/20 text-yellow-400';
    case 'Básico':
      return 'bg-red-500/20 text-red-400';
    default:
      return 'bg-white/10 text-text-tertiary';
  }
}

/* ── Toast ──────────────────────────────────────────────────── */

interface ToastMsg {
  id: number;
  text: string;
  ok: boolean;
}

let toastCounter = 0;

function useToast() {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);

  const show = useCallback((text: string, ok: boolean) => {
    const id = ++toastCounter;
    setToasts((prev) => [...prev, { id, text, ok }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  }, []);

  return { toasts, show };
}

/* ── Stat card ──────────────────────────────────────────────── */

function StatCard({
  label,
  count,
  colorClass,
}: {
  label: string;
  count: number;
  colorClass: string;
}) {
  return (
    <div className="bg-bg-surface border border-border-subtle rounded-xl px-4 py-3 flex flex-col gap-0.5">
      <span className={clsx('text-2xl font-bold tabular-nums', colorClass)}>{count}</span>
      <span className="text-[12px] text-text-secondary">{label}</span>
    </div>
  );
}

/* ── Score cell ─────────────────────────────────────────────── */

function ScoreCell({ val }: { val: number | null }) {
  return (
    <span className={clsx('text-[13px] tabular-nums font-medium', scoreColor(val))}>
      {val !== null ? val : '—'}
    </span>
  );
}

/* ── Row actions ────────────────────────────────────────────── */

interface RowActionsProps {
  audit: IMDAudit;
  onRefresh: (id: string) => void;
  onPush: (id: string) => void;
  onCall: (id: string) => void;
  scoringId: string | null;
  pushingId: string | null;
  callingId: string | null;
}

function RowActions({
  audit,
  onRefresh,
  onPush,
  onCall,
  scoringId,
  pushingId,
  callingId,
}: RowActionsProps) {
  const isScoring = scoringId === audit.id;
  const isPushing = pushingId === audit.id;
  const isCalling = callingId === audit.id;
  const alreadyPushed = audit.ghl_contact_id !== null;
  const canCall = alreadyPushed;

  return (
    <div className="flex items-center gap-1">
      {/* Score / auto-score */}
      <button
        onClick={() => onRefresh(audit.id)}
        disabled={!audit.website || isScoring}
        title={audit.website ? 'Auto-score website' : 'No website'}
        className={clsx(
          'p-1.5 rounded-md transition-colors',
          audit.website && !isScoring
            ? 'text-text-tertiary hover:text-text-primary hover:bg-white/[0.06] cursor-pointer'
            : 'text-text-tertiary/30 cursor-not-allowed',
        )}
      >
        <RefreshCw
          size={13}
          className={clsx(isScoring && 'animate-spin')}
        />
      </button>

      {/* Push to GHL */}
      <button
        onClick={() => !alreadyPushed && onPush(audit.id)}
        disabled={alreadyPushed || isPushing}
        title={alreadyPushed ? 'Already in GHL' : 'Push to GHL'}
        className={clsx(
          'p-1.5 rounded-md transition-colors',
          !alreadyPushed && !isPushing
            ? 'text-text-tertiary hover:text-text-primary hover:bg-white/[0.06] cursor-pointer'
            : 'cursor-not-allowed',
          alreadyPushed ? 'text-green-400' : 'text-text-tertiary/30',
        )}
      >
        {alreadyPushed ? (
          <CheckCircle2 size={13} />
        ) : (
          <Upload size={13} className={clsx(isPushing && 'animate-pulse')} />
        )}
      </button>

      {/* Call */}
      <button
        onClick={() => canCall && onCall(audit.id)}
        disabled={!canCall || isCalling}
        title={canCall ? 'Trigger call' : 'Push to GHL first'}
        className={clsx(
          'p-1.5 rounded-md transition-colors',
          canCall && !isCalling
            ? 'text-text-tertiary hover:text-text-primary hover:bg-white/[0.06] cursor-pointer'
            : 'text-text-tertiary/30 cursor-not-allowed',
        )}
      >
        <Phone size={13} className={clsx(isCalling && 'animate-pulse')} />
      </button>
    </div>
  );
}

/* ── Main dashboard ─────────────────────────────────────────── */

export default function PipelineDashboard() {
  const [audits, setAudits] = useState<IMDAudit[]>([]);
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [industryFilter, setIndustryFilter] = useState<IndustryFilter>('all');
  const [classFilter, setClassFilter] = useState<ClassificationFilter>('all');
  const [search, setSearch] = useState('');

  const [scoringId, setScoringId] = useState<string | null>(null);
  const [pushingId, setPushingId] = useState<string | null>(null);
  const [callingId, setCallingId] = useState<string | null>(null);

  const { toasts, show: showToast } = useToast();

  /* ── Fetch ────────────────────────────────────────────────── */

  const fetchData = useCallback(async () => {
    if (!window.cerebro) return;
    setLoading(true);
    setError(null);
    try {
      const [auditsRes, statsRes] = await Promise.all([
        window.cerebro.invoke({ method: 'GET', path: '/imd/audits' }),
        window.cerebro.invoke({ method: 'GET', path: '/imd/audits/stats' }),
      ]);
      if (!auditsRes.ok) {
        setError(auditsRes.error ?? 'Failed to load audits');
        return;
      }
      setAudits((auditsRes.data as IMDAudit[]) ?? []);
      if (statsRes.ok && statsRes.data) {
        setStats(statsRes.data as AuditStats);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  /* ── Actions ──────────────────────────────────────────────── */

  const handleScore = useCallback(
    async (id: string) => {
      const audit = audits.find((a) => a.id === id);
      if (!audit?.website || !window.cerebro) return;
      setScoringId(id);
      try {
        const scoreRes = await window.cerebro.invoke({
          method: 'POST',
          path: '/integrations/imd/auto-score',
          body: { website: audit.website },
        });
        if (!scoreRes.ok) {
          showToast(scoreRes.error ?? 'Score failed', false);
          return;
        }
        const patchRes = await window.cerebro.invoke({
          method: 'PATCH',
          path: `/imd/audits/${id}`,
          body: scoreRes.data,
        });
        if (patchRes.ok) {
          showToast('Scored successfully', true);
          await fetchData();
        } else {
          showToast(patchRes.error ?? 'Patch failed', false);
        }
      } catch (e) {
        showToast(String(e), false);
      } finally {
        setScoringId(null);
      }
    },
    [audits, fetchData, showToast],
  );

  const handlePush = useCallback(
    async (id: string) => {
      const audit = audits.find((a) => a.id === id);
      if (!audit || !window.cerebro) return;
      setPushingId(id);
      try {
        const res = await window.cerebro.invoke({
          method: 'POST',
          path: '/integrations/ghl/push-lead',
          body: audit,
        });
        if (res.ok) {
          showToast('Pushed to GHL', true);
          await fetchData();
        } else {
          showToast(res.error ?? 'Push failed', false);
        }
      } catch (e) {
        showToast(String(e), false);
      } finally {
        setPushingId(null);
      }
    },
    [audits, fetchData, showToast],
  );

  const handleCall = useCallback(
    async (id: string) => {
      const audit = audits.find((a) => a.id === id);
      if (!audit?.ghl_contact_id || !window.cerebro) return;
      setCallingId(id);
      try {
        const res = await window.cerebro.invoke({
          method: 'POST',
          path: '/integrations/ghl/trigger-call',
          body: { contact_id: audit.ghl_contact_id, language: audit.language },
        });
        if (res.ok) {
          showToast('Call triggered', true);
        } else {
          showToast(res.error ?? 'Call failed', false);
        }
      } catch (e) {
        showToast(String(e), false);
      } finally {
        setCallingId(null);
      }
    },
    [audits, showToast],
  );

  /* ── Filtering ────────────────────────────────────────────── */

  const filtered = audits.filter((a) => {
    if (industryFilter !== 'all' && a.industry !== industryFilter) return false;
    if (classFilter !== 'all' && a.classification !== classFilter) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      if (!a.business_name.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  /* ── Derived stats ────────────────────────────────────────── */

  const displayStats: AuditStats = stats ?? {
    total: audits.length,
    lider: audits.filter((a) => a.classification === 'Líder').length,
    avanzado: audits.filter((a) => a.classification === 'Avanzado').length,
    intermedio: audits.filter((a) => a.classification === 'Intermedio').length,
    basico: audits.filter((a) => a.classification === 'Básico').length,
  };

  /* ── Render ───────────────────────────────────────────────── */

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-bg-base">
      {/* Header */}
      <div className="px-5 pt-3 pb-2 flex items-center justify-between flex-shrink-0">
        <h1 className="text-base font-semibold text-text-primary">IMD-120 Pipeline</h1>
        <button
          onClick={fetchData}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent/10 hover:bg-accent/20 text-accent text-[13px] font-medium transition-colors cursor-pointer border border-accent/20 disabled:opacity-50"
        >
          <RefreshCw size={13} className={clsx(loading && 'animate-spin')} />
          Refresh
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-5 space-y-4">
        {/* Stats bar */}
        <div className="grid grid-cols-5 gap-3">
          <StatCard label="Total Businesses" count={displayStats.total} colorClass="text-text-primary" />
          <StatCard label="Líder" count={displayStats.lider} colorClass="text-blue-400" />
          <StatCard label="Avanzado" count={displayStats.avanzado} colorClass="text-green-400" />
          <StatCard label="Intermedio" count={displayStats.intermedio} colorClass="text-yellow-400" />
          <StatCard label="Básico" count={displayStats.basico} colorClass="text-red-400" />
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3">
          <select
            value={industryFilter}
            onChange={(e) => setIndustryFilter(e.target.value as IndustryFilter)}
            className="text-[13px] bg-bg-surface border border-border-subtle rounded-md px-2.5 py-1.5 text-text-primary focus:outline-none focus:border-accent/50"
          >
            <option value="all">All industries</option>
            <option value="aesthetic-medicine">Aesthetic Medicine</option>
            <option value="dental">Dental</option>
            <option value="legal">Legal</option>
          </select>

          <select
            value={classFilter}
            onChange={(e) => setClassFilter(e.target.value as ClassificationFilter)}
            className="text-[13px] bg-bg-surface border border-border-subtle rounded-md px-2.5 py-1.5 text-text-primary focus:outline-none focus:border-accent/50"
          >
            <option value="all">All classifications</option>
            <option value="Líder">Líder</option>
            <option value="Avanzado">Avanzado</option>
            <option value="Intermedio">Intermedio</option>
            <option value="Básico">Básico</option>
          </select>

          <input
            type="text"
            placeholder="Search business..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="text-[13px] bg-bg-surface border border-border-subtle rounded-md px-2.5 py-1.5 text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 flex-1 max-w-xs"
          />
        </div>

        {/* Error state */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-[13px] text-red-400">
            {error}
          </div>
        )}

        {/* Loading state */}
        {loading && !error && (
          <div className="flex items-center justify-center py-16 text-text-tertiary text-[13px]">
            Loading audits...
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && audits.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
            <Target size={36} className="text-text-tertiary/40" />
            <p className="text-[14px] font-medium text-text-primary">No businesses audited yet</p>
            <p className="text-[13px] text-text-secondary max-w-xs">
              Start by scoring a website in Cerebro chat.
            </p>
          </div>
        )}

        {/* Table */}
        {!loading && !error && audits.length > 0 && (
          <div className="bg-bg-surface border border-border-subtle rounded-xl overflow-hidden">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border-subtle">
                  <th className="text-left px-4 py-2.5 text-text-tertiary font-medium text-[11px] uppercase tracking-wide">Business</th>
                  <th className="text-center px-2 py-2.5 text-text-tertiary font-medium text-[11px] uppercase tracking-wide">D1</th>
                  <th className="text-center px-2 py-2.5 text-text-tertiary font-medium text-[11px] uppercase tracking-wide">D2</th>
                  <th className="text-center px-2 py-2.5 text-text-tertiary font-medium text-[11px] uppercase tracking-wide">D3</th>
                  <th className="text-center px-2 py-2.5 text-text-tertiary font-medium text-[11px] uppercase tracking-wide">D4</th>
                  <th className="text-center px-2 py-2.5 text-text-tertiary font-medium text-[11px] uppercase tracking-wide">D5</th>
                  <th className="text-center px-2 py-2.5 text-text-tertiary font-medium text-[11px] uppercase tracking-wide">D6</th>
                  <th className="text-center px-3 py-2.5 text-text-tertiary font-medium text-[11px] uppercase tracking-wide">Total</th>
                  <th className="text-center px-3 py-2.5 text-text-tertiary font-medium text-[11px] uppercase tracking-wide">Stage</th>
                  <th className="text-right px-4 py-2.5 text-text-tertiary font-medium text-[11px] uppercase tracking-wide">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((audit) => (
                  <tr
                    key={audit.id}
                    className="hover:bg-bg-hover/50 border-b border-border-subtle last:border-b-0"
                  >
                    {/* Business */}
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-text-primary leading-tight">{audit.business_name}</div>
                      {audit.city && (
                        <div className="text-[11px] text-text-tertiary mt-0.5">{audit.city}</div>
                      )}
                    </td>

                    {/* D1–D6 */}
                    <td className="text-center px-2 py-2.5"><ScoreCell val={audit.d1} /></td>
                    <td className="text-center px-2 py-2.5"><ScoreCell val={audit.d2} /></td>
                    <td className="text-center px-2 py-2.5"><ScoreCell val={audit.d3} /></td>
                    <td className="text-center px-2 py-2.5"><ScoreCell val={audit.d4} /></td>
                    <td className="text-center px-2 py-2.5"><ScoreCell val={audit.d5} /></td>
                    <td className="text-center px-2 py-2.5"><ScoreCell val={audit.d6} /></td>

                    {/* Total + classification badge */}
                    <td className="text-center px-3 py-2.5">
                      <div className="flex flex-col items-center gap-1">
                        <span className="font-bold text-text-primary tabular-nums">
                          {audit.total !== null ? audit.total : '—'}
                        </span>
                        {audit.classification && (
                          <span
                            className={clsx(
                              'text-[10px] font-medium px-1.5 py-0.5 rounded-full',
                              classificationBadgeClass(audit.classification),
                            )}
                          >
                            {audit.classification}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Stage */}
                    <td className="text-center px-3 py-2.5">
                      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-white/10 text-text-secondary">
                        {audit.pipeline_stage}
                      </span>
                    </td>

                    {/* Actions */}
                    <td className="text-right px-4 py-2.5">
                      <RowActions
                        audit={audit}
                        onRefresh={handleScore}
                        onPush={handlePush}
                        onCall={handleCall}
                        scoringId={scoringId}
                        pushingId={pushingId}
                        callingId={callingId}
                      />
                    </td>
                  </tr>
                ))}

                {filtered.length === 0 && audits.length > 0 && (
                  <tr>
                    <td colSpan={10} className="text-center py-10 text-text-tertiary text-[13px]">
                      No businesses match the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Toasts */}
      <div className="fixed bottom-5 right-5 flex flex-col gap-2 z-50 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={clsx(
              'px-4 py-2.5 rounded-lg text-[13px] font-medium shadow-lg border',
              t.ok
                ? 'bg-green-500/15 border-green-500/30 text-green-400'
                : 'bg-red-500/15 border-red-500/30 text-red-400',
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
