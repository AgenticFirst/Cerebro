/**
 * Integration coverage for the "no chat draft" bug.
 *
 * Bug (reported in prod): a user types a message in the chat but doesn't send
 * it, navigates to another screen (Tasks/Activity), comes back — and the typed
 * text is gone, because ChatInput kept the draft in local state that died when
 * the component unmounted on screen change.
 *
 * Fix: the draft store lives in ChatContext (mounted above the screen router),
 * keyed per scope; ChatInput is controlled by it. These tests exercise the REAL
 * ChatProvider store wired to the REAL ChatInput, and physically unmount/remount
 * the input the way leaving and returning to the chat screen does. If the store
 * ever moves back into the child (or a call site stops persisting), the
 * round-trip assertions below fail.
 *
 * The sibling unit test (components/chat/__tests__/ChatInput.draft.test.tsx)
 * pins ChatInput's controlled/uncontrolled contract in isolation; this file
 * proves the end-to-end behavior against the actual provider.
 */

import { render, act, fireEvent, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { ChatProvider, useChat, NEW_CHAT_DRAFT_KEY } from './ChatContext';
import ChatInput from '../components/chat/ChatInput';
import i18n from '../i18n';

// ── Mocks for the sibling contexts ChatProvider + ChatInput consume ──
vi.mock('./ProviderContext', () => ({
  useProviders: () => ({
    claudeCodeInfo: { status: 'available' },
    codexInfo: { status: 'available' },
    refreshClaudeCodeStatus: vi.fn(),
    refreshCodexStatus: vi.fn(),
  }),
}));

vi.mock('./EngineContext', () => ({
  useEngine: () => ({
    defaultEngine: 'claude-code',
    setDefaultEngine: vi.fn(),
    engineForConversation: () => 'claude-code',
    setConversationEngine: vi.fn(),
  }),
}));

vi.mock('./QualityContext', () => ({
  useQualityTier: () => ({
    tier: 'balanced',
    setTier: vi.fn(),
    model: 'sonnet',
    setModel: vi.fn(),
  }),
}));

vi.mock('./RoutineContext', () => ({
  useRoutines: () => ({ registerRunCallback: vi.fn(() => vi.fn()) }),
}));

// ChatInput pulls in the toast context for clipboard errors — irrelevant here.
vi.mock('./ToastContext', () => ({ useToast: () => ({ addToast: vi.fn() }) }));

const invokeMock = vi.fn(async (req: { method: string; path: string }) => {
  if (req.method === 'GET' && req.path === '/conversations') {
    return { ok: true, data: { conversations: [] } };
  }
  return { ok: true, data: {} };
});

function installCerebroMock() {
  (window as unknown as { cerebro: unknown }).cerebro = {
    getStatus: vi.fn().mockResolvedValue('healthy'),
    invoke: invokeMock,
    agent: {
      run: vi.fn().mockResolvedValue('run-1'),
      onEvent: vi.fn(() => vi.fn()),
      cancel: vi.fn(),
    },
    telegram: { onConversationUpdated: vi.fn(() => vi.fn()) },
    chatActions: {
      generateTitle: vi.fn().mockResolvedValue(null),
      onTeamRunAnnounced: vi.fn(() => vi.fn()),
      onTeamMemberUpdate: vi.fn(() => vi.fn()),
      onIntegrationProposal: vi.fn(() => vi.fn()),
    },
    claudeCode: { probeAuth: vi.fn().mockResolvedValue(undefined) },
    engine: vi.fn(() => vi.fn()),
  };
}

// ── Test app: mirrors AppLayout's contract — the draft store lives in the
//    always-mounted provider, while ChatInput is conditionally rendered (it
//    unmounts when you leave the chat screen) and keyed by the active scope. ──
let ui: {
  leaveChat: () => void;
  returnToChat: () => void;
  newConversation: () => string;
  activate: (id: string | null) => void;
  activeId: () => string | null;
};

function DraftApp() {
  const c = useChat();
  const [onChatScreen, setOnChatScreen] = useState(true);
  // Welcome view has no conversation yet → NEW_CHAT_DRAFT_KEY, exactly like the app.
  const key = c.activeConversationId ?? NEW_CHAT_DRAFT_KEY;
  ui = {
    leaveChat: () => setOnChatScreen(false),
    returnToChat: () => setOnChatScreen(true),
    newConversation: () => c.createConversation(),
    activate: (id) => c.setActiveConversation(id),
    activeId: () => c.activeConversationId,
  };
  return onChatScreen ? (
    <ChatInput
      onSend={vi.fn()}
      draftValue={c.drafts[key] ?? ''}
      onDraftChange={(v) => c.setDraft(key, v)}
    />
  ) : (
    <div data-testid="other-screen">Tasks</div>
  );
}

function renderApp() {
  render(
    <ChatProvider>
      <DraftApp />
    </ChatProvider>,
  );
}

function textarea(): HTMLTextAreaElement {
  return screen.getByRole('textbox') as HTMLTextAreaElement;
}

function type(text: string) {
  fireEvent.change(textarea(), { target: { value: text } });
}

beforeEach(() => {
  invokeMock.mockClear();
  installCerebroMock();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  i18n.changeLanguage('en');
});

describe('chat draft persistence (integration with real ChatContext store)', () => {
  it('keeps an unsent draft after leaving the chat screen and coming back', async () => {
    renderApp();
    await act(async () => {});

    type('half-written message to Cerebro');

    // Navigate away → ChatInput unmounts (the exact failure condition).
    await act(async () => ui.leaveChat());
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByTestId('other-screen')).toBeInTheDocument();

    // Navigate back → fresh ChatInput, draft restored from the provider store.
    await act(async () => ui.returnToChat());
    expect(textarea()).toHaveValue('half-written message to Cerebro');
  });

  it('survives several round-trips without drift', async () => {
    renderApp();
    await act(async () => {});

    type('persisted across many navigations');
    for (let i = 0; i < 3; i++) {
      await act(async () => ui.leaveChat());
      await act(async () => ui.returnToChat());
    }
    expect(textarea()).toHaveValue('persisted across many navigations');
  });

  it('keeps drafts isolated per conversation', async () => {
    renderApp();
    await act(async () => {});

    // Conversation A
    let convA = '';
    await act(async () => {
      convA = ui.newConversation();
      ui.activate(convA);
    });
    type('draft for conversation A');

    // Switch to a different conversation B → its draft is empty…
    let convB = '';
    await act(async () => {
      convB = ui.newConversation();
      ui.activate(convB);
    });
    expect(textarea()).toHaveValue('');
    type('draft for conversation B');

    // …and switching back to A restores A's draft, not B's.
    await act(async () => ui.activate(convA));
    expect(textarea()).toHaveValue('draft for conversation A');

    await act(async () => ui.activate(convB));
    expect(textarea()).toHaveValue('draft for conversation B');
  });

  it('clears the draft when the message is sent, and it stays cleared after navigation', async () => {
    renderApp();
    await act(async () => {});

    type('send this one');
    // Enter (without shift) sends in ChatInput.
    await act(async () => {
      fireEvent.keyDown(textarea(), { key: 'Enter', shiftKey: false });
    });
    expect(textarea()).toHaveValue('');

    // The cleared state must persist too (no stale draft resurrected on return).
    await act(async () => ui.leaveChat());
    await act(async () => ui.returnToChat());
    expect(textarea()).toHaveValue('');
  });

  it('persists the welcome-screen (new-chat) draft before any conversation exists', async () => {
    renderApp();
    await act(async () => {});

    // No conversation yet → draft is scoped to NEW_CHAT_DRAFT_KEY.
    expect(ui.activeId()).toBeNull();
    type('a thought typed on the welcome screen');

    await act(async () => ui.leaveChat());
    await act(async () => ui.returnToChat());
    expect(textarea()).toHaveValue('a thought typed on the welcome screen');
  });
});
