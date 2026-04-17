import { useTranslation } from 'react-i18next';
import { X, Pencil, Star, Power } from 'lucide-react';
import clsx from 'clsx';
import { useExperts, type Expert } from '../../../../context/ExpertContext';
import ExpertAvatar from './ExpertAvatar';

interface ExpertProfileDrawerProps {
  expert: Expert;
  onClose: () => void;
}

export default function ExpertProfileDrawer({ expert, onClose }: ExpertProfileDrawerProps) {
  const { t } = useTranslation();
  const { toggleEnabled, togglePinned, openExpertInHierarchy } = useExperts();

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
            <ExpertAvatar expert={expert} size={88} />
            <h2 className="mt-3 text-[16px] font-semibold text-text-primary">{expert.name}</h2>
            {expert.domain && (
              <div className="mt-0.5 text-[12px] text-text-tertiary capitalize">{expert.domain}</div>
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

          {/* Skills */}
          {expert.toolAccess && expert.toolAccess.length > 0 && (
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
