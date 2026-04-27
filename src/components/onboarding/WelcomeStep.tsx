/**
 * Welcome step — full-screen, centered hero card with a language picker.
 * Picking a language switches i18n immediately and advances to the first
 * spotlight stop. Replays from Settings skip directly to step 1, so this
 * component is only rendered on first launch (or if explicitly reopened).
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import { useOnboarding, type TourLanguage } from '../../context/OnboardingContext';

export default function WelcomeStep() {
  const { t } = useTranslation();
  const { setLanguageAndAdvance, finish } = useOnboarding();

  // Esc skips the whole tour.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish({ skipped: true });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finish]);

  const pick = (lang: TourLanguage) => setLanguageAndAdvance(lang);

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      <div className="relative w-full max-w-md mx-4 bg-bg-elevated border border-border-subtle rounded-2xl shadow-2xl animate-tour-card-in overflow-hidden">
        {/* Subtle accent header glow */}
        <div
          className="absolute top-0 left-0 right-0 h-32 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 60% 80% at 50% 0%, rgba(6,182,212,0.18), transparent 70%)',
          }}
        />

        <div className="relative px-8 pt-10 pb-6 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-accent/15 border border-accent/25 mb-5">
            <Sparkles size={26} className="text-accent" strokeWidth={1.6} />
          </div>

          <h1 className="text-[22px] font-semibold text-text-primary leading-tight mb-2">
            {t('onboarding.welcome.title')}
          </h1>
          <p className="text-[13px] text-text-secondary leading-relaxed max-w-xs mx-auto">
            {t('onboarding.welcome.body')}
          </p>
        </div>

        <div className="px-8 pb-4">
          <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary text-center mb-3 select-none">
            {t('onboarding.welcome.languagePrompt')}
          </p>
          <div className="grid grid-cols-2 gap-2.5">
            <LanguageButton
              flag="🇺🇸"
              label="English"
              onClick={() => pick('en')}
            />
            <LanguageButton
              flag="🇪🇸"
              label="Español"
              onClick={() => pick('es')}
            />
          </div>
        </div>

        <div className="px-8 pb-6 pt-2 text-center">
          <button
            onClick={() => finish({ skipped: true })}
            className="text-[11px] text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer"
          >
            {t('onboarding.welcome.skipForNow')}
          </button>
        </div>
      </div>
    </div>
  );
}

function LanguageButton({
  flag,
  label,
  onClick,
}: {
  flag: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group flex items-center justify-center gap-2.5 px-4 py-3.5 rounded-xl bg-bg-surface border border-border-subtle hover:border-accent/40 hover:bg-accent/5 transition-all cursor-pointer"
    >
      <span className="twemoji text-[22px] leading-none">{flag}</span>
      <span className="text-[14px] font-medium text-text-primary group-hover:text-accent transition-colors">
        {label}
      </span>
    </button>
  );
}
