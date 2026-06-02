/**
 * Regression test for issue #23 — "Claude auth recovery card still shows the
 * raw error text".
 *
 * When an agent run ends with `errorClass: 'auth'`, the assistant bubble must
 * render ONLY the Claude Code login recovery card. The raw CLI error string
 * (e.g. "run claude in a terminal to sign in") that ChatContext stores in the
 * message content must never be visible — the recovery UI replaces it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../../i18n';
import ChatMessage from '../ChatMessage';
import { ToastProvider } from '../../../context/ToastContext';
import type { Message } from '../../../types/chat';

// ChatMessage and ClaudeCodeLoginCard both call useChat(); stub it so we don't
// have to stand up the whole ChatProvider for a pure-render assertion.
vi.mock('../../../context/ChatContext', () => ({
  useChat: () => ({
    isStreaming: false,
    conversations: [],
    regenerateFromUserMessage: vi.fn(),
  }),
}));

beforeEach(() => {
  // The login card subscribes to the claudeCode login bridge on mount.
  (window as unknown as { cerebro: unknown }).cerebro = {
    claudeCode: {
      login: { onEvent: vi.fn(() => () => undefined) },
    },
  };
});

afterEach(() => cleanup());

describe('ChatMessage auth recovery', () => {
  it('hides raw auth error content when rendering Claude login recovery', () => {
    const message: Message = {
      id: 'm1',
      conversationId: 'c1',
      role: 'assistant',
      content: 'Error: run claude in a terminal to sign in',
      createdAt: new Date(),
      errorClass: 'auth',
    };

    render(
      <ToastProvider>
        <ChatMessage message={message} />
      </ToastProvider>,
    );

    // The recovery card is shown…
    expect(screen.getByText(/sign in to claude/i)).toBeInTheDocument();
    // …and the raw error string is NOT.
    expect(screen.queryByText(/run claude in a terminal/i)).not.toBeInTheDocument();
  });

  it('does not expose the raw auth error via the copy action', () => {
    const message: Message = {
      id: 'm1',
      conversationId: 'c1',
      role: 'assistant',
      content: 'Error: run claude in a terminal to sign in',
      createdAt: new Date(),
      errorClass: 'auth',
    };

    render(
      <ToastProvider>
        <ChatMessage message={message} />
      </ToastProvider>,
    );

    // The recovery card replaces the bubble entirely — there is nothing
    // meaningful to copy, so no copy button (which would otherwise put the
    // raw "Error: run claude…" string on the clipboard) should render.
    expect(screen.queryByLabelText(/copy message/i)).not.toBeInTheDocument();
  });
});
