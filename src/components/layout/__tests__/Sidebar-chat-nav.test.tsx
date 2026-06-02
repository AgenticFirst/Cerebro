/**
 * Regression test for issue #17 — "Sidebar Chat nav reopens the stale active
 * conversation".
 *
 * Navigating Chat -> Routines -> Chat through the sidebar must clear the active
 * conversation so the Chat surface falls back to the welcome/input state until a
 * conversation is explicitly selected. The bug was that the nav handler skipped
 * clearing whenever the destination was `chat`, so the previous thread stayed
 * active and AppLayout re-rendered its message list.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const setActiveConversation = vi.fn();
const setActiveScreen = vi.fn();

vi.mock('../../../context/ChatContext', () => ({
  useChat: () => ({
    generalConversations: [],
    activeConversationId: 'conv-1',
    activeScreen: 'routines',
    isLoading: false,
    startNewChat: vi.fn(),
    setActiveConversation,
    setActiveScreen,
    renameConversation: vi.fn(),
    deleteConversation: vi.fn(),
  }),
}));

vi.mock('../../../context/ApprovalContext', () => ({
  useApprovals: () => ({ pendingCount: 0 }),
}));

vi.mock('../../../context/TaskContext', () => ({
  useTasks: () => ({ stats: { in_progress: 0, to_review: 0 } }),
}));

vi.mock('../../../context/OnboardingContext', () => ({
  useOnboarding: () => ({ spotlightedNavId: null }),
}));

import Sidebar from '../Sidebar';

describe('Sidebar — Chat nav clears the active conversation', () => {
  beforeEach(() => {
    setActiveConversation.mockClear();
    setActiveScreen.mockClear();
  });

  it('clears the active conversation when the Chat nav item is clicked', () => {
    render(<Sidebar />);

    // The Chat nav label resolves to its i18n key via the mocked t().
    fireEvent.click(screen.getByText('nav.chat'));

    expect(setActiveScreen).toHaveBeenCalledWith('chat');
    // The previous thread must be cleared so the welcome state shows.
    expect(setActiveConversation).toHaveBeenCalledWith(null);

    cleanup();
  });
});
