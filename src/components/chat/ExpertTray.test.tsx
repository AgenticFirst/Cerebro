/**
 * Regression test: the builtin "Cerebro" expert is a TASK assignee only. It
 * must not leak into the chat expert tray, which already renders its own
 * hard-coded Cerebro pill (the default "no specific expert" target). Without
 * the filter the user would see two Cerebro pills.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { Expert } from '../../context/ExpertContext';
import { isCerebroExpert } from '../../shared/agent-name';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const expertsState: { experts: Expert[]; loadExperts: () => void } = {
  experts: [],
  loadExperts: vi.fn(),
};
// Mirror ExpertContext: `specialistExperts` is the roster minus the builtin Cerebro.
vi.mock('../../context/ExpertContext', () => ({
  useExperts: () => ({
    ...expertsState,
    specialistExperts: expertsState.experts.filter((e) => !isCerebroExpert(e)),
  }),
}));

const chatState = { activeExpertId: null as string | null, setActiveExpertId: vi.fn() };
vi.mock('../../context/ChatContext', () => ({
  useChat: () => chatState,
}));

import ExpertTray from './ExpertTray';

function makeExpert(overrides: Partial<Expert> = {}): Expert {
  return {
    id: 'e1',
    slug: null,
    name: 'Expert One',
    domain: null,
    description: '',
    systemPrompt: null,
    type: 'expert',
    source: 'user',
    isEnabled: true,
    isPinned: false,
    isVerified: false,
    toolAccess: null,
    policies: null,
    requiredConnections: null,
    recommendedRoutines: null,
    teamMembers: null,
    strategy: null,
    coordinatorPrompt: null,
    avatarUrl: null,
    maxTurns: 10,
    tokenBudget: 1000,
    version: '1',
    lastActiveAt: null,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    ...overrides,
  } as Expert;
}

describe('ExpertTray — excludes the builtin Cerebro', () => {
  beforeEach(() => {
    expertsState.experts = [];
  });
  afterEach(cleanup);

  it('does not render a second pill for the Cerebro expert row', () => {
    expertsState.experts = [
      makeExpert({ id: 'cerebro', name: 'Cerebro', source: 'builtin', isVerified: true }),
      makeExpert({ id: 'e2', name: 'Sales Analyst' }),
    ];
    render(<ExpertTray />);

    // The hard-coded default pill uses the i18n key, not the expert name.
    expect(screen.getByText('expertTray.cerebro')).toBeInTheDocument();
    // The real expert is shown…
    expect(screen.getByText('Sales Analyst')).toBeInTheDocument();
    // …but the builtin Cerebro expert produces no "Cerebro"-named pill.
    expect(screen.queryByText('Cerebro')).not.toBeInTheDocument();
  });
});
