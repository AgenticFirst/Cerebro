/**
 * Reusable tooltip card body — header (progress + close), title with emoji,
 * body copy, dot progress, and the Skip / Back / Next button row. Used by
 * the spotlight overlay; the welcome and completion steps have their own
 * larger custom layouts.
 */

import { useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import clsx from 'clsx';

interface TooltipCardProps {
  emoji?: string;
  title: string;
  body: string;
  /** 0-indexed within the spotlight sequence (excludes welcome/completion). */
  visibleIndex: number;
  visibleCount: number;
  onNext: () => void;
  onPrev: () => void;
  onSkip: () => void;
  /** Fixed-position style applied by the spotlight overlay. */
  style?: CSSProperties;
  /** Cardinal direction the card is pointing — drives the tail position. */
  side?: 'top' | 'bottom' | 'left' | 'right' | 'auto';
  isFirstSpotlight?: boolean;
  isLastSpotlight?: boolean;
}

export default function TooltipCard({
  emoji,
  title,
  body,
  visibleIndex,
  visibleCount,
  onNext,
  onPrev,
  onSkip,
  style,
  isFirstSpotlight,
  isLastSpotlight,
}: TooltipCardProps) {
  const { t } = useTranslation();
  const [confirmingSkip, setConfirmingSkip] = useState(false);

  return (
    <div
      role="dialog"
      aria-live="polite"
      aria-labelledby="tour-tooltip-title"
      className={clsx(
        'fixed z-[10001] w-[360px] max-w-[calc(100vw-32px)]',
        'bg-bg-elevated border border-border-subtle rounded-xl shadow-2xl',
        'animate-tour-card-in',
      )}
      style={style}
    >
      {/* Header — progress + close */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <span className="text-[11px] font-medium text-text-tertiary tabular-nums tracking-wide">
          {t('onboarding.progress', {
            current: visibleIndex + 1,
            total: visibleCount,
          })}
        </span>
        <button
          onClick={() => setConfirmingSkip(true)}
          className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
          title={t('onboarding.skip')}
          aria-label={t('onboarding.skip')}
        >
          <X size={14} />
        </button>
      </div>

      {/* Title + body */}
      <div className="px-4 pb-3">
        <h3
          id="tour-tooltip-title"
          className="text-[15px] font-semibold text-text-primary leading-tight mb-1.5 flex items-center gap-2"
        >
          {emoji && <span className="twemoji text-[18px] leading-none">{emoji}</span>}
          <span>{title}</span>
        </h3>
        <p className="text-[13px] text-text-secondary leading-relaxed">{body}</p>
      </div>

      {/* Dot progress */}
      <div className="flex items-center justify-center gap-1.5 pb-3">
        {Array.from({ length: visibleCount }).map((_, i) => (
          <span
            key={i}
            className={clsx(
              'h-1.5 rounded-full transition-all duration-200',
              i === visibleIndex
                ? 'w-4 bg-accent'
                : i < visibleIndex
                  ? 'w-1.5 bg-accent/40'
                  : 'w-1.5 bg-text-tertiary/30',
            )}
          />
        ))}
      </div>

      {/* Action row */}
      <div className="border-t border-border-subtle px-4 py-3 flex items-center justify-between">
        {confirmingSkip ? (
          <div className="flex items-center justify-between gap-2 w-full">
            <span className="text-[11px] text-text-secondary">
              {t('onboarding.skipConfirm')}
            </span>
            <div className="flex gap-1.5">
              <button
                onClick={() => setConfirmingSkip(false)}
                className="px-3 py-1.5 rounded-md text-[12px] font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
              >
                {t('onboarding.skipKeep')}
              </button>
              <button
                onClick={onSkip}
                className="px-3 py-1.5 rounded-md text-[12px] font-medium bg-bg-hover text-text-primary hover:bg-white/[0.08] transition-colors cursor-pointer"
              >
                {t('onboarding.skipConfirmYes')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <button
              onClick={() => setConfirmingSkip(true)}
              className="px-2 py-1.5 rounded-md text-[12px] font-medium text-text-tertiary hover:text-text-primary transition-colors cursor-pointer"
            >
              {t('onboarding.skip')}
            </button>
            <div className="flex items-center gap-1.5">
              <button
                onClick={onPrev}
                disabled={isFirstSpotlight}
                className={clsx(
                  'px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors',
                  isFirstSpotlight
                    ? 'text-text-tertiary/40 cursor-default'
                    : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover cursor-pointer',
                )}
              >
                {t('onboarding.back')}
              </button>
              <button
                onClick={onNext}
                className="px-3 py-1.5 rounded-md text-[12px] font-medium bg-accent text-bg-base hover:bg-accent-hover transition-colors cursor-pointer"
              >
                {isLastSpotlight ? t('onboarding.finish') : t('onboarding.next')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
