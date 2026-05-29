/**
 * OnboardingTour — top-level controller. Mounted at App root next to the
 * ToastContainer so it always renders above the entire app. Decides which
 * sub-component to show based on the current step kind.
 *
 * Side-effect: when `step.screen` is set, the controller drives the global
 * active screen via ChatContext so the spotlight has something real to point
 * at. SettingsScreen reads `forcedSettingsSection` from OnboardingContext
 * so it can override its inner active section for the Memory step.
 */

import { useEffect } from 'react';
import { useOnboarding } from '../../context/OnboardingContext';
import { useChat } from '../../context/ChatContext';
import { TOUR_STEPS } from './tour-steps';
import WelcomeStep from './WelcomeStep';
import SpotlightStep from './SpotlightStep';
import CompletionStep from './CompletionStep';
import InstallCheckStep from './InstallCheckStep';

export default function OnboardingTour() {
  const {
    isOpen,
    step,
    stepIndex,
    next,
    prev,
    finish,
    standaloneInstallCheck,
    markInstallSeen,
  } = useOnboarding();
  const { setActiveScreen } = useChat();

  // Drive the active screen from the current step.
  useEffect(() => {
    if (!isOpen) return;
    if (step.screen) {
      setActiveScreen(step.screen);
    }
  }, [isOpen, step.screen, setActiveScreen]);

  // Keyboard nav for spotlight steps. Welcome/completion handle their own.
  useEffect(() => {
    if (!isOpen || step.kind !== 'spotlight') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (isLastSpotlight) finish({ skipped: false });
        else next();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (!isFirstSpotlight) prev();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish({ skipped: true });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, step, stepIndex]);

  if (!isOpen) return null;

  // Compute spotlight progress (welcome and completion are excluded).
  const spotlightSteps = TOUR_STEPS.filter((s) => s.kind === 'spotlight');
  const visibleIndex = spotlightSteps.findIndex((s) => s.id === step.id);
  const visibleCount = spotlightSteps.length;
  const isFirstSpotlight = visibleIndex === 0;
  const isLastSpotlight = visibleIndex === visibleCount - 1;

  if (step.kind === 'welcome') {
    return <WelcomeStep />;
  }

  if (step.kind === 'install-check') {
    return (
      <InstallCheckStep
        standalone={standaloneInstallCheck}
        onSeen={markInstallSeen}
        onAdvance={() => {
          // In standalone mode (existing user, missing CLI) we just close —
          // there's no celebration to advance to. In tour mode we hand off
          // to the next step (which is the celebration).
          if (standaloneInstallCheck) {
            finish({ skipped: false });
          } else {
            next();
          }
        }}
      />
    );
  }

  if (step.kind === 'completion') {
    return <CompletionStep />;
  }

  return (
    <SpotlightStep
      step={step}
      visibleIndex={visibleIndex}
      visibleCount={visibleCount}
      onNext={next}
      onPrev={prev}
      onSkip={() => finish({ skipped: true })}
      isFirstSpotlight={isFirstSpotlight}
      isLastSpotlight={isLastSpotlight}
    />
  );
}
