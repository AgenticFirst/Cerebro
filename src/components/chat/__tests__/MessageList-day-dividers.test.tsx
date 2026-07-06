/**
 * Day dividers in the message stream — "in conversations only the time is
 * shown, so you can't tell what day a message happened". A divider must
 * appear before the first message and whenever the local day changes, and
 * each timestamp carries the full date in its title tooltip.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../../i18n';
import MessageList from '../MessageList';
import { ToastProvider } from '../../../context/ToastContext';
import { dayDividerLabel } from '../../../context/chat-helpers';
import type { Message } from '../../../types/chat';

// ChatMessage calls useChat(); stub it so we don't need the full ChatProvider.
vi.mock('../../../context/ChatContext', () => ({
  useChat: () => ({
    isStreaming: false,
    conversations: [],
    regenerateFromUserMessage: vi.fn(),
  }),
}));

afterEach(() => cleanup());

function msg(id: string, createdAt: Date, role: 'user' | 'assistant' = 'user'): Message {
  return { id, conversationId: 'c1', role, content: `msg ${id}`, createdAt };
}

function daysAgo(days: number, hours: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hours, 0, 0, 0);
  return d;
}

describe('MessageList day dividers', () => {
  it('renders one divider per local day, labelled Today/Yesterday/date', () => {
    const oldDay = daysAgo(40, 10);
    const messages = [
      msg('m1', oldDay),
      msg('m2', daysAgo(40, 11), 'assistant'), // same old day — no extra divider
      msg('m3', daysAgo(1, 9)),
      msg('m4', daysAgo(0, 8)),
    ];

    render(
      <ToastProvider>
        <MessageList messages={messages} conversationId="c1" />
      </ToastProvider>,
    );

    expect(screen.getAllByRole('separator')).toHaveLength(3);
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Yesterday')).toBeInTheDocument();

    const oldLabel = dayDividerLabel(oldDay, new Date(), 'en');
    if (!('text' in oldLabel)) throw new Error('expected a formatted date label');
    expect(screen.getByText(oldLabel.text)).toBeInTheDocument();
  });

  it('exposes the full date on each timestamp via the title tooltip', () => {
    const createdAt = daysAgo(40, 10);
    const { container } = render(
      <ToastProvider>
        <MessageList messages={[msg('m1', createdAt)]} conversationId="c1" />
      </ToastProvider>,
    );

    const expected = createdAt.toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' });
    expect(container.querySelector(`span[title="${expected}"]`)).toBeInTheDocument();
  });
});
