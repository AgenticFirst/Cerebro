import { render, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { ChatProvider, useChat } from './ChatContext';
import i18n from '../i18n';
import type { ClaudeCodeInfo } from '../types/providers';
import type { EngineId } from '../engines/types';

/**
 * Regression coverage for the conversation auto-rename bug.
 *
 * Bug: auto-titling only fired when `sendMessage` *lazily created* the
 * conversation (the old `createdHere` gate). The "New Chat" button and new
 * expert threads pre-create an EMPTY conversation first, so by the time the
 * first message was sent the conversation already existed and auto-titling was
 * skipped — the title stayed "New conversation" / "Nueva conversación" forever.
 *
 * Fix: trigger auto-titling on the conversation's FIRST USER MESSAGE instead
 * (`isFirstUserTurn`), which covers both the lazy-create and pre-created-empty
 * paths. These tests lock that behaviour in and guard the safety properties
 * (no re-title on later turns, manual rename wins).
 */

// ── Controllable mocks for the sibling contexts ChatProvider consumes ──
let mockClaudeCodeInfo: ClaudeCodeInfo = { status: 'available' };
let mockCodexInfo: ClaudeCodeInfo = { status: 'available' };
let mockDefaultEngine: EngineId = 'claude-code';

vi.mock('./ProviderContext', () => ({
  useProviders: () => ({
    claudeCodeInfo: mockClaudeCodeInfo,
    codexInfo: mockCodexInfo,
    refreshClaudeCodeStatus: vi.fn(),
    refreshCodexStatus: vi.fn(),
  }),
}));

vi.mock('./EngineContext', () => ({
  useEngine: () => ({
    defaultEngine: mockDefaultEngine,
    setDefaultEngine: vi.fn(),
    engineForConversation: () => mockDefaultEngine,
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
  useRoutines: () => ({
    registerRunCallback: vi.fn(() => vi.fn()),
  }),
}));

// ── window.cerebro surface ────────────────────────────────────────
const agentRun = vi.fn().mockResolvedValue('run-1');

// Captures the event handler ChatContext subscribes with so tests can drive a
// synthetic `done` event (to exercise the phase-2 refine pass).
let capturedEventHandler: ((event: { type: string; messageContent?: string }) => void) | null =
  null;
const agentOnEvent = vi.fn((_runId: string, handler: (event: { type: string }) => void) => {
  capturedEventHandler = handler as typeof capturedEventHandler;
  return vi.fn();
});

// Records every backend write so we can assert the title PATCH fired.
const invokeMock = vi.fn(async (req: { method: string; path: string; body?: unknown }) => {
  if (req.method === 'GET' && req.path === '/conversations') {
    return { ok: true, data: { conversations: [] } };
  }
  return { ok: true, data: {} };
});

// The auto-title generator. Default: returns a fixed title so the happy path
// produces a real rename. Resolves on a macrotask to mirror the real IPC round
// trip — generation is always slower than React's commit, so `runAutoTitle`
// reads a committed conversation ref (a microtask-resolved mock would race the
// commit and read stale state, which never happens with the real CLI call).
function titleResolver(title: string | null) {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return title;
  };
}
const generateTitleMock = vi.fn(titleResolver('Generated Title'));

function installCerebroMock() {
  (window as unknown as { cerebro: unknown }).cerebro = {
    getStatus: vi.fn().mockResolvedValue('healthy'),
    invoke: invokeMock,
    agent: { run: agentRun, onEvent: agentOnEvent, cancel: vi.fn() },
    telegram: { onConversationUpdated: vi.fn(() => vi.fn()) },
    chatActions: {
      generateTitle: generateTitleMock,
      onTeamRunAnnounced: vi.fn(() => vi.fn()),
      onTeamMemberUpdate: vi.fn(() => vi.fn()),
      onIntegrationProposal: vi.fn(() => vi.fn()),
    },
    claudeCode: { probeAuth: vi.fn().mockResolvedValue(undefined) },
    engine: vi.fn(() => vi.fn()),
  };
}

// ── Harness exposing the slice of context the tests drive ──────────
interface Ctx {
  sendMessage: (content: string) => void;
  startNewChat: () => void;
  createConversation: (firstMessage?: string, opts?: { expertId?: string | null }) => string;
  renameConversation: (id: string, title: string) => void;
  setActiveConversation: (id: string | null) => void;
  activeConversationId: string | null;
  titleOf: (id: string) => string | undefined;
}

let ctx: Ctx;

function Harness() {
  const c = useChat();
  ctx = {
    sendMessage: c.sendMessage,
    startNewChat: c.startNewChat,
    createConversation: c.createConversation,
    renameConversation: c.renameConversation,
    setActiveConversation: c.setActiveConversation,
    activeConversationId: c.activeConversationId,
    titleOf: (id: string) => c.conversations.find((conv) => conv.id === id)?.title,
  };
  return null;
}

function renderChat(): void {
  render(
    (
      <ChatProvider>
        <Harness />
      </ChatProvider>
    ) as ReactNode,
  );
}

function titlePatchCalls(): Array<{ path: string; title: unknown }> {
  return invokeMock.mock.calls
    .map(([req]) => req)
    .filter(
      (req) =>
        req &&
        req.method === 'PATCH' &&
        typeof req.path === 'string' &&
        req.path.startsWith('/conversations/') &&
        !req.path.includes('/messages'),
    )
    .map((req) => ({
      path: req.path as string,
      title: (req.body as { title?: unknown } | undefined)?.title,
    }));
}

beforeEach(() => {
  agentRun.mockClear();
  agentOnEvent.mockClear();
  invokeMock.mockClear();
  generateTitleMock.mockClear();
  generateTitleMock.mockImplementation(titleResolver('Generated Title'));
  capturedEventHandler = null;
  mockClaudeCodeInfo = { status: 'available' };
  mockCodexInfo = { status: 'available' };
  mockDefaultEngine = 'claude-code';
  installCerebroMock();
});

afterEach(() => {
  vi.clearAllMocks();
  i18n.changeLanguage('en');
});

describe('ChatContext conversation auto-title', () => {
  it('auto-titles after the New Chat button pre-creates an empty conversation (the bug)', async () => {
    renderChat();

    // 1. User clicks "New Chat" → an empty "New conversation" is created and
    //    becomes active BEFORE any message is sent. This is the path that used
    //    to skip auto-titling entirely.
    await act(async () => {
      ctx.startNewChat();
    });
    const convId = ctx.activeConversationId;
    expect(convId).toBeTruthy();

    // 2. User sends the first message in that pre-existing conversation.
    await act(async () => {
      ctx.sendMessage('Explain quantum entanglement in simple terms');
    });

    // Phase-1 auto-title must fire on the first user message.
    await waitFor(() => {
      expect(generateTitleMock).toHaveBeenCalledWith({
        userMessage: 'Explain quantum entanglement in simple terms',
        assistantResponse: undefined,
      });
    });

    // …and the generated title must be persisted via PATCH /conversations/{id}.
    await waitFor(() => {
      const patches = titlePatchCalls();
      expect(patches).toContainEqual({
        path: `/conversations/${convId}`,
        title: 'Generated Title',
      });
    });

    // …and reflected in local state (sidebar label).
    expect(ctx.titleOf(convId as string)).toBe('Generated Title');
  });

  it('still auto-titles when the conversation is lazily created from the welcome screen', async () => {
    renderChat();

    // No active conversation → sendMessage creates it inline (the path that
    // already worked before the fix; guard against regressing it).
    await act(async () => {
      ctx.sendMessage('Plan a weekend trip to Lisbon');
    });

    await waitFor(() => {
      expect(generateTitleMock).toHaveBeenCalledWith({
        userMessage: 'Plan a weekend trip to Lisbon',
        assistantResponse: undefined,
      });
    });
    const convId = ctx.activeConversationId as string;
    await waitFor(() => {
      expect(titlePatchCalls()).toContainEqual({
        path: `/conversations/${convId}`,
        title: 'Generated Title',
      });
    });
  });

  it('auto-titles a pre-created expert thread on its first message', async () => {
    renderChat();

    // New expert thread: createConversation(undefined, { expertId }) then
    // activate — exactly what ExpertThreadView.handleNewThread does.
    let convId = '';
    await act(async () => {
      convId = ctx.createConversation(undefined, { expertId: 'expert-123' });
      ctx.setActiveConversation(convId);
    });

    await act(async () => {
      ctx.sendMessage('Review my Q3 sales numbers');
    });

    await waitFor(() => {
      expect(generateTitleMock).toHaveBeenCalledWith({
        userMessage: 'Review my Q3 sales numbers',
        assistantResponse: undefined,
      });
    });
    await waitFor(() => {
      expect(titlePatchCalls()).toContainEqual({
        path: `/conversations/${convId}`,
        title: 'Generated Title',
      });
    });
  });

  it('does not re-run phase-1 auto-title on a later message in the same conversation', async () => {
    renderChat();

    await act(async () => {
      ctx.startNewChat();
    });

    await act(async () => {
      ctx.sendMessage('first message');
    });
    await waitFor(() => expect(generateTitleMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      ctx.sendMessage('a follow-up message');
    });

    // The follow-up is NOT the first user turn, so no new phase-1 title call.
    // (Give microtasks a chance to flush before asserting the absence.)
    await act(async () => {
      await Promise.resolve();
    });
    expect(generateTitleMock).toHaveBeenCalledTimes(1);
    expect(generateTitleMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ userMessage: 'a follow-up message' }),
    );
  });

  it('runs the phase-2 refine pass (user + assistant) once the response completes', async () => {
    renderChat();

    await act(async () => {
      ctx.startNewChat();
    });
    await act(async () => {
      ctx.sendMessage('How do I deploy a FastAPI app');
    });

    // Phase 1 fired with just the user message.
    await waitFor(() =>
      expect(generateTitleMock).toHaveBeenCalledWith({
        userMessage: 'How do I deploy a FastAPI app',
        assistantResponse: undefined,
      }),
    );
    expect(capturedEventHandler).toBeTruthy();

    // Drive the agent `done` event → phase-2 refine should run with BOTH the
    // first user message and the final assistant response. This only works
    // because the conversation id was registered for auto-titling on the first
    // turn (the fix); previously it was absent for pre-created conversations.
    await act(async () => {
      capturedEventHandler!({
        type: 'done',
        messageContent: 'Use uvicorn behind a process manager and a reverse proxy.',
      });
    });

    await waitFor(() =>
      expect(generateTitleMock).toHaveBeenCalledWith({
        userMessage: 'How do I deploy a FastAPI app',
        assistantResponse: 'Use uvicorn behind a process manager and a reverse proxy.',
      }),
    );
  });

  it('does not overwrite a manually renamed conversation', async () => {
    renderChat();

    await act(async () => {
      ctx.startNewChat();
    });
    const convId = ctx.activeConversationId as string;

    await act(async () => {
      ctx.sendMessage('draft a launch email');
    });
    await waitFor(() => expect(ctx.titleOf(convId)).toBe('Generated Title'));

    // User manually renames — this must hand title ownership back to the user.
    await act(async () => {
      ctx.renameConversation(convId, 'My Manual Title');
    });
    expect(ctx.titleOf(convId)).toBe('My Manual Title');

    // Now the assistant response completes. The phase-2 refine must NOT clobber
    // the manual title even though a (different) title would be generated.
    generateTitleMock.mockImplementation(titleResolver('Different Auto Title'));
    await act(async () => {
      capturedEventHandler!({ type: 'done', messageContent: 'Here is your email draft.' });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(ctx.titleOf(convId)).toBe('My Manual Title');
    // No PATCH should have set the post-rename generated title.
    expect(titlePatchCalls()).not.toContainEqual({
      path: `/conversations/${convId}`,
      title: 'Different Auto Title',
    });
  });
});
