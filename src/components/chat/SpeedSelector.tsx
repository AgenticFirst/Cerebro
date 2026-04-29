import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Gauge, Check } from 'lucide-react';
import clsx from 'clsx';
import { useQualityTier } from '../../context/QualityContext';
import { QUALITY_TIERS, RESPONSE_MODELS } from '../../types/ipc';

interface OptionRowProps {
  active: boolean;
  onClick: () => void;
  label: string;
  trailing?: string;
  description: string;
}

function OptionRow({ active, onClick, label, trailing, description }: OptionRowProps) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onClick}
      className={clsx(
        'w-full flex items-start gap-2 px-2.5 py-2 rounded-lg text-left',
        'transition-colors',
        active ? 'bg-bg-hover' : 'hover:bg-bg-hover/60',
      )}
    >
      <span
        className={clsx(
          'flex-shrink-0 w-4 h-4 mt-0.5 flex items-center justify-center rounded-full border',
          active ? 'border-accent text-accent' : 'border-border-subtle text-transparent',
        )}
      >
        <Check size={11} strokeWidth={3} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="flex items-baseline gap-1.5">
          <span className="text-xs font-medium text-text-primary">{label}</span>
          {trailing && (
            <span className="text-[10px] font-medium text-text-tertiary tabular-nums">
              {trailing}
            </span>
          )}
        </span>
        <span className="block text-[11px] text-text-tertiary leading-snug mt-0.5">
          {description}
        </span>
      </span>
    </button>
  );
}

export default function SpeedSelector() {
  const { t } = useTranslation();
  const { tier, setTier, model, setModel } = useQualityTier();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close popover on outside click / Esc.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const tierLabel = t(`chat.speedSelector.tiers.${tier}.label`);
  const modelLabel = t(`chat.speedSelector.models.${model}.label`);
  const tooltip = t('chat.speedSelector.tooltipFormat', { tier: tierLabel, model: modelLabel });

  return (
    <div ref={wrapperRef} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          'flex-shrink-0 flex items-center justify-center',
          'w-8 h-8 rounded-lg transition-all duration-150',
          'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover',
          open && 'text-text-secondary bg-bg-hover',
        )}
        title={tooltip}
        aria-label={t('chat.speedSelector.label')}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Gauge size={15} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t('chat.speedSelector.label')}
          className={clsx(
            'absolute bottom-full mb-2 right-0 z-20 w-80',
            'rounded-xl border border-border-subtle bg-bg-elevated shadow-lg',
            'p-1 animate-fade-in',
          )}
        >
          {/* Speed section */}
          <div className="px-2.5 pt-2 pb-1">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
              {t('chat.speedSelector.sections.speed')}
            </div>
            <div className="text-[10px] text-text-tertiary/70 mt-0.5">
              {t('chat.speedSelector.sections.speedHint')}
            </div>
          </div>
          <div role="radiogroup" aria-label={t('chat.speedSelector.sections.speed')}>
            {QUALITY_TIERS.map((opt) => (
              <OptionRow
                key={opt}
                active={opt === tier}
                onClick={() => setTier(opt)}
                label={t(`chat.speedSelector.tiers.${opt}.label`)}
                trailing={t(`chat.speedSelector.tiers.${opt}.eta`)}
                description={t(`chat.speedSelector.tiers.${opt}.description`)}
              />
            ))}
          </div>

          {/* Divider */}
          <div className="my-1 border-t border-border-subtle/60" />

          {/* Model section */}
          <div className="px-2.5 pt-2 pb-1">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
              {t('chat.speedSelector.sections.model')}
            </div>
            <div className="text-[10px] text-text-tertiary/70 mt-0.5">
              {t('chat.speedSelector.sections.modelHint')}
            </div>
          </div>
          <div role="radiogroup" aria-label={t('chat.speedSelector.sections.model')}>
            {RESPONSE_MODELS.map((opt) => (
              <OptionRow
                key={opt}
                active={opt === model}
                onClick={() => setModel(opt)}
                label={t(`chat.speedSelector.models.${opt}.label`)}
                description={t(`chat.speedSelector.models.${opt}.description`)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
