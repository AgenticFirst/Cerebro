import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import clsx from 'clsx';
import type { RunRecord } from './types';
import { timeAgo, formatDuration, STATUS_CONFIG, RUN_TYPE_LABELS, TRIGGER_LABELS } from './helpers';
import StatusDot from './StatusDot';

interface RunCardProps {
  run: RunRecord;
  index: number;
  routineName?: string;
  isSelected: boolean;
  onClick: () => void;
  onNavigateApprovals?: () => void;
}

export default function RunCard({ run, index, routineName, isSelected, onClick, onNavigateApprovals }: RunCardProps) {
  const cfg = STATUS_CONFIG[run.status] ?? STATUS_CONFIG.created;
  const isRunning = run.status === 'running';
  const isPaused = run.status === 'paused';
  const isFailed = run.status === 'failed';
  const isPreview = run.run_type === 'preview';
  const isOrchestration = run.run_type === 'orchestration';

  // Live elapsed timer for running runs
  const [elapsed, setElapsed] = useState<number | null>(null);

  useEffect(() => {
    if (!isRunning) { setElapsed(null); return; }
    const start = new Date(run.started_at).getTime();
    const tick = () => setElapsed(Date.now() - start);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isRunning, run.started_at]);

  const displayName = routineName ?? RUN_TYPE_LABELS[run.run_type] ?? run.run_type;
  const duration = isRunning ? formatDuration(elapsed) : formatDuration(run.duration_ms);

  return (
    <div
      onClick={onClick}
      className={clsx(
        'bg-bg-surface border rounded-lg p-4 cursor-pointer hover:border-border-default transition-colors animate-card-in',
        isSelected ? 'border-accent/30 bg-accent/[0.03]' : 'border-border-subtle',
      )}
      style={{ animationDelay: `${Math.min(index * 40, 600)}ms` }}
    >
      <div className="flex items-start gap-3">
        {/* Status dot */}
        <div className="pt-0.5">
          <StatusDot status={run.status} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Top row */}
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-sm font-medium text-text-primary truncate">
              {displayName}
            </span>
            {isOrchestration && (
              <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent/10 text-accent border border-accent/20 flex-shrink-0">
                Orchestration
              </span>
            )}
            {isPreview && (
              <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-bg-elevated text-text-tertiary border border-border-subtle flex-shrink-0">
                Preview
              </span>
            )}
          </div>

          {/* Metadata row */}
          <div className="flex items-center gap-3 text-[11px] text-text-tertiary">
            <span>{timeAgo(run.started_at)}</span>
            <span className="flex items-center gap-1">
              {isRunning && <Loader2 size={10} className="animate-spin text-yellow-500" />}
              {run.completed_steps}/{run.total_steps} steps
            </span>
            <span>{TRIGGER_LABELS[run.trigger] ?? run.trigger}</span>
          </div>

          {/* Paused indicator — links to Approvals screen */}
          {isPaused && (
            <button
              onClick={(e) => { e.stopPropagation(); onNavigateApprovals?.(); }}
              className="mt-1.5 text-[11px] text-amber-400 font-medium hover:text-amber-300 transition-colors text-left"
            >
              Awaiting approval &rarr;
            </button>
          )}

          {/* Failed error */}
          {isFailed && run.error && (
            <p className="mt-1.5 text-[11px] text-red-400 line-clamp-1">
              {run.error}
            </p>
          )}
        </div>

        {/* Duration + status label */}
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <span className="text-xs tabular-nums text-text-secondary">{duration}</span>
          <span className={clsx('text-[10px] font-medium', cfg.text)}>{cfg.label}</span>
        </div>
      </div>
    </div>
  );
}
