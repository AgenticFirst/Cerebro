import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Users,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
} from 'lucide-react';
import clsx from 'clsx';
import type { TeamRun, TeamRunMember } from '../../types/chat';

interface TeamRunCardProps {
  teamRun: TeamRun;
}

function MemberStatusIcon({ status }: { status: TeamRunMember['status'] }) {
  if (status === 'running') return <Loader2 size={12} className="animate-spin text-cyan-400" />;
  if (status === 'completed') return <CheckCircle2 size={12} className="text-green-500" />;
  if (status === 'error') return <XCircle size={12} className="text-red-500" />;
  return <Clock size={12} className="text-zinc-500" />;
}

function StrategyBadge({ strategy }: { strategy: string }) {
  return (
    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-cyan-500/15 text-cyan-400">
      {strategy}
    </span>
  );
}

function RunStatusBadge({ status }: { status: TeamRun['status'] }) {
  const { t } = useTranslation();
  const styles = {
    running: 'bg-yellow-500/15 text-yellow-400',
    completed: 'bg-green-500/15 text-green-400',
    error: 'bg-red-500/15 text-red-400',
  };
  const labels = {
    running: t('status.running'),
    completed: t('status.completed'),
    error: t('status.failed'),
  };
  return (
    <span className={clsx('text-[10px] font-medium px-1.5 py-0.5 rounded-full', styles[status])}>
      {labels[status]}
    </span>
  );
}

function formatElapsed(t: ReturnType<typeof useTranslation>['t'], ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return t('teamRun.elapsedSeconds', { seconds: totalSeconds });
  return t('teamRun.elapsedMinutes', { minutes, seconds });
}

export default function TeamRunCard({ teamRun }: TeamRunCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [expandedMember, setExpandedMember] = useState<string | null>(null);
  const isRunning = teamRun.status === 'running';
  const startedAt = teamRun.startedAt;

  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!isRunning || !startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isRunning, startedAt]);

  return (
    <div
      className={clsx(
        'animate-card-in rounded-lg border overflow-hidden',
        isRunning
          ? 'border-cyan-500/30 bg-bg-surface/50'
          : teamRun.status === 'completed'
            ? 'border-green-500/20 bg-bg-surface/50'
            : 'border-red-500/20 bg-bg-surface/50',
      )}
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-bg-hover/50 transition-colors cursor-pointer"
      >
        <Users size={14} className={isRunning ? 'text-cyan-400' : 'text-text-secondary'} />
        <span className="flex-1 text-xs font-medium text-text-secondary truncate">
          {teamRun.teamName}
        </span>
        <StrategyBadge strategy={teamRun.strategy} />
        <RunStatusBadge status={teamRun.status} />
        <ChevronRight
          size={12}
          className={clsx(
            'text-text-tertiary transition-transform duration-200 flex-shrink-0',
            expanded && 'rotate-90',
          )}
        />
      </button>

      {/* Member list */}
      {expanded && (
        <div className="border-t border-border-subtle">
          {teamRun.members.map((member) => (
            <div key={member.memberId} className="border-b border-border-subtle last:border-b-0">
              <button
                onClick={() =>
                  setExpandedMember(expandedMember === member.memberId ? null : member.memberId)
                }
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-bg-hover/30 transition-colors cursor-pointer"
              >
                <MemberStatusIcon status={member.status} />
                <span className="flex-1 text-[11px] text-text-secondary truncate">
                  {member.memberName}
                </span>
                <span className="text-[10px] text-text-tertiary">{member.role}</span>
                {member.response && (
                  <ChevronRight
                    size={10}
                    className={clsx(
                      'text-text-tertiary transition-transform duration-200',
                      expandedMember === member.memberId && 'rotate-90',
                    )}
                  />
                )}
              </button>
              {expandedMember === member.memberId && member.response && (
                <div className="px-3 py-2 bg-bg-base/50">
                  <div className="text-[11px] text-text-tertiary leading-relaxed whitespace-pre-wrap max-h-40 overflow-y-auto">
                    {member.response}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Summary footer */}
      {teamRun.status !== 'running' && teamRun.successCount !== undefined && (
        <div className="border-t border-border-subtle px-3 py-1.5">
          <span className="text-[10px] text-text-tertiary">
            {t('teamRun.completedProgress', { done: teamRun.successCount, total: teamRun.totalCount })}
          </span>
        </div>
      )}

      {/* Elapsed counter while running */}
      {isRunning && startedAt && (
        <div className="border-t border-border-subtle px-3 py-1.5">
          <span className="text-[10px] text-text-tertiary tabular-nums">
            {formatElapsed(t, now - startedAt)}
          </span>
        </div>
      )}
    </div>
  );
}
