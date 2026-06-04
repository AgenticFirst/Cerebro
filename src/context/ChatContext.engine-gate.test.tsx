import { render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { ChatProvider, useChat } from './ChatContext';
import i18n from '../i18n';
import type { ClaudeCodeInfo } from '../types/providers';
import type { EngineId } from '../engines/types';

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
    // New conversations resolve the app-wide default engine.
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

// Minimal window.cerebro surface ChatProvider touches during mount + send.
const agentRun = vi.fn().mockResolvedValue('run-1');
const agentOnEvent = vi.fn(() => vi.fn());

function installCerebroMock() {
  (window as unknown as { cerebro: unknown }).cerebro = {
    getStatus: vi.fn().mockResolvedValue('healthy'),
    invoke: vi.fn().mockResolvedValue({ ok: true, data: { conversations: [] } }),
    agent: { run: agentRun, onEvent: agentOnEvent, cancel: vi.fn() },
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

// Test harness: renders the provider and exposes sendMessage + chatError.
let sendRef: (content: string) => void;
let errorTitle: string | null;
let errorMessage: string | null;

function Harness() {
  const { sendMessage, chatError } = useChat();
  sendRef = sendMessage;
  errorTitle = chatError?.title ?? null;
  errorMessage = chatError?.message ?? null;
  return <div data-testid="error">{chatError?.title ?? 'no-error'}</div>;
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

beforeEach(() => {
  agentRun.mockClear();
  agentOnEvent.mockClear();
  mockClaudeCodeInfo = { status: 'available' };
  mockCodexInfo = { status: 'available' };
  mockDefaultEngine = 'claude-code';
  installCerebroMock();
});

afterEach(() => {
  vi.clearAllMocks();
  i18n.changeLanguage('en');
});

describe('ChatContext engine availability gate', () => {
  it('allows Codex chat when Claude Code is missing', async () => {
    mockClaudeCodeInfo = { status: 'unavailable' };
    mockCodexInfo = { status: 'available' };
    mockDefaultEngine = 'codex';

    renderChat();

    await act(async () => {
      sendRef('hello');
    });

    // Bug: previously the Claude-Code-not-detected modal blocked the send.
    expect(errorTitle).not.toBe('Claude Code not detected');
    expect(screen.getByTestId('error').textContent).toBe('no-error');
    expect(agentRun).toHaveBeenCalledWith(expect.objectContaining({ engine: 'codex' }));
  });

  it('still blocks Claude Code chat when Claude Code is missing', async () => {
    mockClaudeCodeInfo = { status: 'unavailable' };
    mockCodexInfo = { status: 'available' };
    mockDefaultEngine = 'claude-code';

    renderChat();

    await act(async () => {
      sendRef('hello');
    });

    expect(errorTitle).toBe('Claude Code not detected');
    expect(agentRun).not.toHaveBeenCalled();
  });

  it('blocks Codex chat when Codex is missing', async () => {
    mockClaudeCodeInfo = { status: 'available' };
    mockCodexInfo = { status: 'unavailable' };
    mockDefaultEngine = 'codex';

    renderChat();

    await act(async () => {
      sendRef('hello');
    });

    expect(errorTitle).toBe('Codex not detected');
    expect(agentRun).not.toHaveBeenCalled();
  });

  it('localizes the Claude-Code-unavailable modal to Spanish', async () => {
    i18n.changeLanguage('es');
    mockClaudeCodeInfo = { status: 'unavailable' };
    mockCodexInfo = { status: 'available' };
    mockDefaultEngine = 'claude-code';

    renderChat();

    await act(async () => {
      sendRef('hola');
    });

    // Bug: the modal title/message were hardcoded English regardless of locale.
    expect(errorTitle).toBe('Claude Code no detectado');
    expect(errorTitle).not.toBe('Claude Code not detected');
    expect(errorMessage).toContain('Integraciones');
    expect(agentRun).not.toHaveBeenCalled();
  });

  it('localizes the Codex-unavailable modal to Spanish', async () => {
    i18n.changeLanguage('es');
    mockClaudeCodeInfo = { status: 'available' };
    mockCodexInfo = { status: 'unavailable' };
    mockDefaultEngine = 'codex';

    renderChat();

    await act(async () => {
      sendRef('hola');
    });

    expect(errorTitle).toBe('Codex no detectado');
    expect(errorTitle).not.toBe('Codex not detected');
    expect(errorMessage).toContain('Integraciones');
    expect(agentRun).not.toHaveBeenCalled();
  });
});
