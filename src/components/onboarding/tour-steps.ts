/**
 * Tour step definitions. The sequence drives the OnboardingTour controller —
 * each step optionally targets a `data-tour-id` element on a particular screen
 * and shows a tooltip card with copy from the i18n bundle (`onboarding.steps.*`).
 *
 * Welcome and completion are rendered by dedicated components, so they appear
 * here only as bookends with `kind: 'welcome' | 'completion'`.
 */

import type { Screen } from '../../types/chat';

export type TourStepKind = 'welcome' | 'spotlight' | 'install-check' | 'completion';

export interface TourStep {
  id: string;
  kind: TourStepKind;
  /** Active screen the spotlight needs the user on. */
  screen?: Screen;
  /** When the screen has its own inner sidebar (Settings) we drive it. */
  settingsSection?: 'memory';
  /** `data-tour-id` of the element to spotlight. Absent → centered modal. */
  target?: string;
  /** Preferred tooltip side; falls back automatically if it would clip. */
  side?: 'top' | 'bottom' | 'left' | 'right' | 'auto';
  /** Lead emoji shown next to the title — pure delight. */
  emoji?: string;
  /** i18n keys (relative to `onboarding.steps.{id}`). */
  titleKey: string;
  bodyKey: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    kind: 'welcome',
    titleKey: 'onboarding.welcome.title',
    bodyKey: 'onboarding.welcome.body',
  },
  {
    id: 'chat',
    kind: 'spotlight',
    screen: 'chat',
    target: 'chat-welcome',
    side: 'auto',
    emoji: '💬',
    titleKey: 'onboarding.steps.chat.title',
    bodyKey: 'onboarding.steps.chat.body',
  },
  {
    id: 'experts',
    kind: 'spotlight',
    screen: 'experts',
    target: 'nav-experts',
    side: 'right',
    emoji: '🧑‍🚀',
    titleKey: 'onboarding.steps.experts.title',
    bodyKey: 'onboarding.steps.experts.body',
  },
  {
    id: 'tasks',
    kind: 'spotlight',
    screen: 'tasks',
    target: 'tasks-board',
    side: 'auto',
    emoji: '🎯',
    titleKey: 'onboarding.steps.tasks.title',
    bodyKey: 'onboarding.steps.tasks.body',
  },
  {
    id: 'routines',
    kind: 'spotlight',
    screen: 'routines',
    target: 'routines-create',
    side: 'auto',
    emoji: '🔁',
    titleKey: 'onboarding.steps.routines.title',
    bodyKey: 'onboarding.steps.routines.body',
  },
  {
    id: 'approvals',
    kind: 'spotlight',
    screen: 'approvals',
    target: 'approvals-tabs',
    side: 'auto',
    emoji: '🛡️',
    titleKey: 'onboarding.steps.approvals.title',
    bodyKey: 'onboarding.steps.approvals.body',
  },
  {
    id: 'integrations',
    kind: 'spotlight',
    screen: 'integrations',
    target: 'integrations-apps',
    side: 'auto',
    emoji: '🔌',
    titleKey: 'onboarding.steps.integrations.title',
    bodyKey: 'onboarding.steps.integrations.body',
  },
  {
    id: 'memory',
    kind: 'spotlight',
    screen: 'settings',
    settingsSection: 'memory',
    target: 'settings-memory',
    side: 'auto',
    emoji: '🧠',
    titleKey: 'onboarding.steps.memory.title',
    bodyKey: 'onboarding.steps.memory.body',
  },
  {
    id: 'install-check',
    kind: 'install-check',
    titleKey: 'onboarding.installCheck.prompt.title',
    bodyKey: 'onboarding.installCheck.prompt.body',
  },
  {
    id: 'done',
    kind: 'completion',
    titleKey: 'onboarding.completion.title',
    bodyKey: 'onboarding.completion.body',
  },
];

/** Total number of advance‑able steps shown in the dot progress. */
export const TOUR_VISIBLE_STEP_COUNT = TOUR_STEPS.filter(
  (s) => s.kind === 'spotlight',
).length;
