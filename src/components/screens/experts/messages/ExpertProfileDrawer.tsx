import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BadgeCheck, ChevronDown, ChevronRight, Lock, Pencil, Power, Star, Users, X } from 'lucide-react';
import clsx from 'clsx';
import { useExperts, type Expert } from '../../../../context/ExpertContext';
import ExpertAvatar from './ExpertAvatar';
import TeamAvatar from './TeamAvatar';

interface ExpertProfileDrawerProps {
  expert: Expert;
  onClose: () => void;
  onSelectMember?: (expertId: string) => void;
}

export default function ExpertProfileDrawer({ expert, onClose, onSelectMember }: ExpertProfileDrawerProps) {
  const { t } = useTranslation();
  const { experts: allExperts, toggleEnabled, togglePinned, openExpertInHierarchy } = useExperts();
  const [coordinatorOpen, setCoordinatorOpen] = useState(false);

  const isTeam = expert.type === 'team';

  const members = useMemo(() => {
    if (!isTeam) return [];
    const ordered = (expert.teamMembers ?? []).slice().sort((a, b) => a.order - b.order);
    const byId = new Map(allExperts.map((e) => [e.id, e] as const));
    return ordered.map((m) => ({ role: m.role, expert: byId.get(m.expertId) ?? null }));
  }, [isTeam, expert.teamMembers, allExperts]);

  const strategyKey = expert.strategy === 'parallel'
    ? 'experts.teamStrategyParallel'
    : expert.strategy === 'auto'
      ? 'experts.teamStrategyAuto'
      : 'experts.teamStrategySequential';
  const strategyHelpKey = expert.strategy === 'parallel'
    ? 'experts.teamStrategyParallelHelp'
    : expert.strategy === 'auto'
      ? 'experts.teamStrategyAutoHelp'
      : 'experts.teamStrategySequentialHelp';

  const handleEdit = () => {
    openExpertInHierarchy(expert.id);
    onClose();
  };

  return (
    <>
      {/* Backdrop (captures outside clicks) */}
      <div
        className="absolute inset-0 z-20 bg-black/30"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={clsx(
          'absolute top-0 right-0 bottom-0 z-30 w-[380px]',
          'bg-bg-surface border-l border-border-subtle',
          'flex flex-col shadow-2xl',
          'animate-slide-in-right',
        )}
        role="dialog"
        aria-label={t('experts.openProfile')}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <span className="text-[11px] font-semibold text-text-tertiary uppercase tracking-[0.08em]">
            {t('experts.openProfile')}
          </span>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-7 h-7 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {/* Hero */}
          <div className="px-5 pt-6 pb-4 flex flex-col items-center text-center border-b border-border-subtle">
            {isTeam ? (
              <TeamAvatar
                team={expert}
                members={members.map((m) => m.expert).filter((e): e is Expert => Boolean(e))}
                size={88}
              />
            ) : (
              <ExpertAvatar expert={expert} size={88} />
            )}
            <h2 className="mt-3 text-[16px] font-semibold text-text-primary inline-flex items-center gap-1.5">
              {expert.name}
              {expert.isVerified && (
                <BadgeCheck size={14} className="text-accent" strokeWidth={2.25} />
              )}
            </h2>
            {isTeam && (
              <div className="mt-1.5 flex items-center gap-1.5">
                <span className="inline-flex items-center gap-1 px-1.5 py-px rounded-full bg-accent/10 text-[10px] font-medium text-accent uppercase tracking-wide">
                  <Users size={10} strokeWidth={2.5} />
                  {t('experts.teamLabel')}
                </span>
                <span className="px-1.5 py-px rounded-full bg-amber-500/15 text-[10px] font-medium text-amber-400 uppercase tracking-wide">
                  {t('experts.groupBeta')}
                </span>
              </div>
            )}
            {expert.domain && (
              <div className="mt-1 text-[12px] text-text-tertiary capitalize">{expert.domain}</div>
            )}
            <div className="mt-1.5 flex items-center gap-1.5">
              <span
                className={clsx(
                  'w-1.5 h-1.5 rounded-full',
                  expert.isEnabled ? 'bg-emerald-500' : 'bg-text-tertiary/40',
                )}
              />
              <span className="text-[11px] text-text-tertiary">
                {expert.isEnabled ? t('experts.connected') : t('experts.filterDisabled')}
              </span>
            </div>
            {expert.isVerified ? (
              <div className="mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11.5px] text-text-tertiary bg-bg-elevated border border-border-subtle">
                <Lock size={11} />
                {t('experts.teamVerifiedNote')}
              </div>
            ) : (
              <button
                onClick={handleEdit}
                className={clsx(
                  'mt-4 flex items-center gap-1.5 px-3 py-1.5 rounded-md',
                  'text-[12px] font-medium text-accent bg-accent/10 hover:bg-accent/20',
                  'border border-accent/30 transition-colors cursor-pointer',
                )}
              >
                <Pencil size={12} />
                {t('experts.editInHierarchy')}
              </button>
            )}
          </div>

          {/* Description */}
          {expert.description && (
            <div className="px-5 py-4 border-b border-border-subtle">
              <div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-[0.08em] mb-1.5">
                {t('experts.description')}
              </div>
              <p className="text-[12.5px] text-text-secondary leading-relaxed whitespace-pre-wrap">
                {expert.description}
              </p>
            </div>
          )}

          {/* Team — Members */}
          {isTeam && members.length > 0 && (
            <div className="px-5 py-4 border-b border-border-subtle">
              <div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-[0.08em] mb-2">
                {t('experts.teamMembersHeader')}
              </div>
              <div className="flex flex-col gap-1.5">
                {members.map((m, idx) => {
                  if (!m.expert) {
                    return (
                      <div
                        key={`missing-${idx}`}
                        className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-bg-elevated text-[12px] text-text-tertiary italic"
                      >
                        {m.role} — unavailable
                      </div>
                    );
                  }
                  const memberExpert = m.expert;
                  return (
                    <button
                      key={memberExpert.id}
                      onClick={() =>
                        onSelectMember
                          ? onSelectMember(memberExpert.id)
                          : openExpertInHierarchy(memberExpert.id)
                      }
                      className="flex items-center gap-2.5 px-2 py-1.5 rounded-md text-left hover:bg-bg-hover transition-colors cursor-pointer"
                    >
                      <ExpertAvatar expert={memberExpert} size={28} />
                      <div className="flex-1 min-w-0">
                        <div className="text-[12.5px] font-medium text-text-primary truncate">
                          {memberExpert.name}
                        </div>
                        <div className="text-[11px] text-text-tertiary truncate">{m.role}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Team — Strategy */}
          {isTeam && (
            <div className="px-5 py-4 border-b border-border-subtle">
              <div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-[0.08em] mb-2">
                {t('experts.teamStrategyHeader')}
              </div>
              <div className="inline-flex items-center px-2 py-0.5 rounded-full bg-accent/10 text-[11.5px] font-medium text-accent">
                {t(strategyKey)}
              </div>
              <p className="mt-1.5 text-[12px] text-text-secondary leading-relaxed">
                {t(strategyHelpKey)}
              </p>
            </div>
          )}

          {/* Team — Coordinator prompt (collapsible) */}
          {isTeam && expert.coordinatorPrompt && (
            <div className="px-5 py-4 border-b border-border-subtle">
              <button
                onClick={() => setCoordinatorOpen((v) => !v)}
                className="w-full flex items-center justify-between text-[10px] font-semibold text-text-tertiary uppercase tracking-[0.08em] hover:text-text-secondary transition-colors cursor-pointer"
              >
                <span>{t('experts.teamCoordinatorHeader')}</span>
                {coordinatorOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
              {coordinatorOpen && (
                <pre className="mt-2 text-[11.5px] text-text-secondary whitespace-pre-wrap leading-relaxed font-sans">
                  {expert.coordinatorPrompt}
                </pre>
              )}
            </div>
          )}

          {/* Skills */}
          {!isTeam && expert.toolAccess && expert.toolAccess.length > 0 && (
            <div className="px-5 py-4 border-b border-border-subtle">
              <div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-[0.08em] mb-2">
                {t('experts.skills')}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {expert.toolAccess.map((tool) => (
                  <span
                    key={tool}
                    className="text-[11px] px-2 py-0.5 rounded-full bg-bg-elevated border border-border-subtle text-text-secondary"
                  >
                    {tool}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Toggles */}
          <div className="px-5 py-4 flex flex-col gap-2">
            <button
              onClick={() => togglePinned(expert)}
              className={clsx(
                'flex items-center justify-between px-3 py-2 rounded-md',
                'text-[12.5px] transition-colors cursor-pointer',
                expert.isPinned
                  ? 'bg-accent/10 text-accent'
                  : 'bg-bg-elevated text-text-secondary hover:text-text-primary',
              )}
            >
              <span className="flex items-center gap-2">
                <Star size={13} strokeWidth={expert.isPinned ? 2.5 : 1.8} />
                {t('experts.starred')}
              </span>
              <span className="text-[11px] text-text-tertiary">
                {expert.isPinned ? '✓' : ''}
              </span>
            </button>
            <button
              onClick={() => toggleEnabled(expert)}
              className={clsx(
                'flex items-center justify-between px-3 py-2 rounded-md',
                'text-[12.5px] transition-colors cursor-pointer',
                expert.isEnabled
                  ? 'bg-emerald-500/10 text-emerald-400'
                  : 'bg-bg-elevated text-text-secondary hover:text-text-primary',
              )}
            >
              <span className="flex items-center gap-2">
                <Power size={13} />
                {t('experts.enabled')}
              </span>
              <span className="text-[11px] text-text-tertiary">
                {expert.isEnabled ? '✓' : ''}
              </span>
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
