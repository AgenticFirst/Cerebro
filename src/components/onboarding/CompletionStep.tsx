/**
 * Completion step — celebrate, then drop the user back into Chat.
 *
 * Reuses the on-brand astronaut Lottie (already shipped with the app for
 * the chat empty state). Confetti is pure CSS keyframes — no extra deps.
 */

import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Lottie from 'lottie-react';
import astronautAnimation from '../../assets/lottie/astronaut.json';
import { useOnboarding } from '../../context/OnboardingContext';
import { useChat } from '../../context/ChatContext';

const CONFETTI_COUNT = 32;
const CONFETTI_COLORS = [
  '#06b6d4', // accent cyan
  '#22d3ee',
  '#a5f3fc',
  '#fde68a', // warm
  '#f472b6', // pink
  '#a78bfa', // violet
  '#34d399', // green
];

interface ConfettiPiece {
  left: number;
  drift: number;
  delay: number;
  duration: number;
  color: string;
  size: number;
  rounded: boolean;
}

export default function CompletionStep() {
  const { t } = useTranslation();
  const { finish } = useOnboarding();
  const { setActiveScreen } = useChat();

  // Precompute confetti randomness once so it doesn't churn on re-render.
  const pieces = useMemo<ConfettiPiece[]>(
    () =>
      Array.from({ length: CONFETTI_COUNT }, () => ({
        left: Math.random() * 100,
        drift: (Math.random() - 0.5) * 200,
        delay: Math.random() * 0.6,
        duration: 2.6 + Math.random() * 1.6,
        color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
        size: 6 + Math.random() * 6,
        rounded: Math.random() > 0.5,
      })),
    [],
  );

  // Esc still closes (graceful exit even on the celebration screen).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') handleDone();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDone = () => {
    setActiveScreen('chat');
    finish({ skipped: false });
  };

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center overflow-hidden">
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" />

      {/* Confetti — absolute pieces falling top → bottom. */}
      <div className="pointer-events-none absolute inset-0">
        {pieces.map((p, i) => (
          <span
            key={i}
            className="absolute top-0 animate-confetti-fall"
            style={{
              left: `${p.left}%`,
              width: p.size,
              height: p.size * (p.rounded ? 1 : 1.5),
              backgroundColor: p.color,
              borderRadius: p.rounded ? '50%' : '2px',
              ['--confetti-drift' as string]: `${p.drift}px`,
              ['--confetti-delay' as string]: `${p.delay}s`,
              ['--confetti-duration' as string]: `${p.duration}s`,
            }}
          />
        ))}
      </div>

      {/* Hero card */}
      <div className="relative w-full max-w-md mx-4 bg-bg-elevated border border-border-subtle rounded-2xl shadow-2xl animate-tour-card-in overflow-hidden">
        <div
          className="absolute top-0 left-0 right-0 h-40 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 60% 80% at 50% 0%, rgba(6,182,212,0.22), transparent 70%)',
          }}
        />

        <div className="relative pt-4 px-6 pb-2 flex justify-center">
          <div className="relative h-[180px] w-[180px]">
            <div
              aria-hidden
              className="absolute inset-0 rounded-full blur-3xl"
              style={{
                background:
                  'radial-gradient(circle at 50% 55%, rgba(6,182,212,0.30) 0%, rgba(6,182,212,0.08) 45%, transparent 72%)',
              }}
            />
            <Lottie
              animationData={astronautAnimation}
              loop
              autoplay
              className="relative z-10 h-full w-full"
              rendererSettings={{ preserveAspectRatio: 'xMidYMid meet' }}
            />
          </div>
        </div>

        <div className="relative px-8 pb-6 text-center">
          <h1 className="text-[22px] font-semibold text-text-primary leading-tight mb-2">
            {t('onboarding.completion.title')}
          </h1>
          <p className="text-[13px] text-text-secondary leading-relaxed mb-6">
            {t('onboarding.completion.body')}
          </p>

          <button
            onClick={handleDone}
            className="w-full px-4 py-3 rounded-xl bg-accent text-bg-base text-[14px] font-semibold hover:bg-accent-hover transition-colors cursor-pointer"
          >
            {t('onboarding.completion.cta')}
          </button>
          <p className="mt-3 text-[11px] text-text-tertiary">
            {t('onboarding.completion.replayHint')}
          </p>
        </div>
      </div>
    </div>
  );
}
