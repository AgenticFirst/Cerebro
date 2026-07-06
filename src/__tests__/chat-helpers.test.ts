import { describe, it, expect } from 'vitest';
import {
  generateId,
  titleFromContent,
  buildAgentErrorContent,
  fromApiConversation,
  fromApiMessage,
  toApiProposal,
  resolveNewChatTarget,
  isSameLocalDay,
  isUntitledConversationTitle,
  dayDividerLabel,
} from '../context/chat-helpers';
import type { ApiConversation, ApiMessage } from '../context/chat-helpers';
import type { Conversation, Message } from '../types/chat';

function makeConv(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: `c-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Untitled',
    expertId: null,
    createdAt: new Date('2026-04-20T10:00:00'),
    updatedAt: new Date('2026-04-20T10:00:00'),
    messages: [],
    ...overrides,
  };
}

function msg(): Message {
  return {
    id: generateId(),
    conversationId: 'x',
    role: 'user',
    content: 'hi',
    createdAt: new Date(),
  };
}

describe('generateId', () => {
  it('returns a 32-char hex string with no dashes', () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).not.toContain('-');
  });
});

describe('titleFromContent', () => {
  it('passes short strings through unchanged', () => {
    expect(titleFromContent('Hello world')).toBe('Hello world');
  });

  it('truncates strings longer than 40 chars with ellipsis', () => {
    const long = 'A'.repeat(60);
    const result = titleFromContent(long);
    expect(result).toBe('A'.repeat(40) + '...');
    expect(result.length).toBe(43);
  });
});

describe('buildAgentErrorContent', () => {
  const AUTH_ERROR = 'run claude in a terminal to sign in';

  it('embeds the raw error for ordinary failures (no partial text)', () => {
    expect(buildAgentErrorContent('', 'boom', 'unknown')).toBe('Error: boom');
  });

  it('keeps partial text above the error for ordinary failures', () => {
    expect(buildAgentErrorContent('hello', 'boom', 'unknown')).toBe('hello\n\n---\n_Error: boom_');
  });

  it('never writes the raw auth error into the body (the recovery card replaces it)', () => {
    const content = buildAgentErrorContent('', AUTH_ERROR, 'auth');
    expect(content).toBe('');
    expect(content).not.toContain(AUTH_ERROR);
    expect(content).not.toContain('Error:');
  });

  it('preserves only the partial prose for auth failures, dropping the raw error', () => {
    const content = buildAgentErrorContent('Here is what I found', AUTH_ERROR, 'auth');
    expect(content).toBe('Here is what I found');
    expect(content).not.toContain(AUTH_ERROR);
  });
});

describe('fromApiConversation', () => {
  it('maps snake_case API JSON to camelCase Conversation with Date objects', () => {
    const api: ApiConversation = {
      id: 'abc123',
      title: 'Test Chat',
      created_at: '2025-01-15T10:30:00Z',
      updated_at: '2025-01-15T11:00:00Z',
      messages: [
        {
          id: 'msg1',
          conversation_id: 'abc123',
          role: 'user',
          content: 'Hello',
          model: null,
          token_count: null,
          expert_id: null,
          agent_run_id: null,
          metadata: null,
          created_at: '2025-01-15T10:30:00Z',
        },
      ],
    };

    const conv = fromApiConversation(api);

    expect(conv.id).toBe('abc123');
    expect(conv.title).toBe('Test Chat');
    expect(conv.createdAt).toBeInstanceOf(Date);
    expect(conv.updatedAt).toBeInstanceOf(Date);
    expect(conv.createdAt.toISOString()).toBe('2025-01-15T10:30:00.000Z');
    expect(conv.messages).toHaveLength(1);
    expect(conv.messages[0].conversationId).toBe('abc123');
    expect(conv.messages[0].createdAt).toBeInstanceOf(Date);
    expect(conv.messages[0].model).toBeUndefined();
    expect(conv.messages[0].tokenCount).toBeUndefined();
  });
});

describe('fromApiMessage', () => {
  const base: ApiMessage = {
    id: 'msg1',
    conversation_id: 'conv1',
    role: 'assistant',
    content: 'Hello',
    model: null,
    token_count: null,
    expert_id: null,
    agent_run_id: null,
    metadata: null,
    created_at: '2025-06-01T12:00:00Z',
  };

  it('hydrates expertId and agentRunId from API fields', () => {
    const msg = fromApiMessage({ ...base, expert_id: 'exp1', agent_run_id: 'run1' });
    expect(msg.expertId).toBe('exp1');
    expect(msg.agentRunId).toBe('run1');
  });

  it('hydrates engineRunId from metadata', () => {
    const msg = fromApiMessage({ ...base, metadata: { engine_run_id: 'engine42' } });
    expect(msg.engineRunId).toBe('engine42');
  });

  it('hydrates routineProposal from metadata with correct type mapping', () => {
    const msg = fromApiMessage({
      ...base,
      metadata: {
        routine_proposal: {
          name: 'Morning Routine',
          description: 'Start the day',
          steps: ['Check calendar', 'Draft plan'],
          trigger_type: 'cron',
          cron_expression: '0 8 * * *',
          default_runner_id: 'runner1',
          required_connections: ['google_calendar'],
          approval_gates: ['step2'],
          status: 'saved',
          saved_routine_id: 'routine1',
        },
      },
    });
    expect(msg.routineProposal).toBeDefined();
    expect(msg.routineProposal!.name).toBe('Morning Routine');
    expect(msg.routineProposal!.triggerType).toBe('cron');
    expect(msg.routineProposal!.cronExpression).toBe('0 8 * * *');
    expect(msg.routineProposal!.defaultRunnerId).toBe('runner1');
    expect(msg.routineProposal!.requiredConnections).toEqual(['google_calendar']);
    expect(msg.routineProposal!.approvalGates).toEqual(['step2']);
    expect(msg.routineProposal!.status).toBe('saved');
    expect(msg.routineProposal!.savedRoutineId).toBe('routine1');
  });

  it('handles null metadata gracefully', () => {
    const msg = fromApiMessage({ ...base, metadata: null });
    expect(msg.engineRunId).toBeUndefined();
    expect(msg.routineProposal).toBeUndefined();
  });

  it('handles empty metadata gracefully', () => {
    const msg = fromApiMessage({ ...base, metadata: {} });
    expect(msg.engineRunId).toBeUndefined();
    expect(msg.routineProposal).toBeUndefined();
  });

  it('sets expertId and agentRunId to undefined when null', () => {
    const msg = fromApiMessage(base);
    expect(msg.expertId).toBeUndefined();
    expect(msg.agentRunId).toBeUndefined();
  });

  it('hydrates isPreviewRun from metadata', () => {
    const msg = fromApiMessage({
      ...base,
      metadata: { engine_run_id: 'run1', is_preview_run: true },
    });
    expect(msg.isPreviewRun).toBe(true);
  });

  it('does not set isPreviewRun when metadata flag is absent', () => {
    const msg = fromApiMessage({
      ...base,
      metadata: { engine_run_id: 'run1' },
    });
    expect(msg.isPreviewRun).toBeUndefined();
  });

  it('hydrates previewRunId on routineProposal from metadata', () => {
    const msg = fromApiMessage({
      ...base,
      metadata: {
        routine_proposal: {
          name: 'Test',
          steps: ['step1'],
          trigger_type: 'manual',
          status: 'previewing',
          preview_run_id: 'prev_run_42',
          required_connections: [],
          approval_gates: [],
        },
      },
    });
    expect(msg.routineProposal).toBeDefined();
    expect(msg.routineProposal!.previewRunId).toBe('prev_run_42');
    expect(msg.routineProposal!.status).toBe('previewing');
  });
});

describe('toApiProposal', () => {
  it('includes preview_run_id in serialized output', () => {
    const result = toApiProposal({
      name: 'Test',
      description: '',
      steps: ['step1'],
      triggerType: 'manual',
      requiredConnections: [],
      approvalGates: [],
      status: 'previewing',
      previewRunId: 'prev_run_42',
    });
    expect(result.preview_run_id).toBe('prev_run_42');
  });

  it('omits preview_run_id when undefined', () => {
    const result = toApiProposal({
      name: 'Test',
      description: '',
      steps: ['step1'],
      triggerType: 'manual',
      requiredConnections: [],
      approvalGates: [],
      status: 'proposed',
    });
    expect(result.preview_run_id).toBeUndefined();
  });
});

describe('isUntitledConversationTitle', () => {
  it('treats null, undefined, and empty strings as untitled', () => {
    expect(isUntitledConversationTitle(null)).toBe(true);
    expect(isUntitledConversationTitle(undefined)).toBe(true);
    expect(isUntitledConversationTitle('')).toBe(true);
    expect(isUntitledConversationTitle('   ')).toBe(true);
  });

  it('treats historical English defaults as untitled (case-insensitive)', () => {
    expect(isUntitledConversationTitle('New conversation')).toBe(true);
    expect(isUntitledConversationTitle('new conversation')).toBe(true);
    expect(isUntitledConversationTitle('New Chat')).toBe(true);
    expect(isUntitledConversationTitle('Untitled')).toBe(true);
  });

  it('keeps user-chosen titles even when similar-looking', () => {
    expect(isUntitledConversationTitle('New conversation ideas')).toBe(false);
    expect(isUntitledConversationTitle('Release plan')).toBe(false);
    expect(isUntitledConversationTitle('Chat with mom')).toBe(false);
  });
});

describe('isSameLocalDay', () => {
  it('treats two times on the same local date as equal', () => {
    expect(isSameLocalDay(new Date('2026-04-20T00:05:00'), new Date('2026-04-20T23:55:00'))).toBe(
      true,
    );
  });

  it('treats different local dates as distinct', () => {
    expect(isSameLocalDay(new Date('2026-04-20T23:59:00'), new Date('2026-04-21T00:01:00'))).toBe(
      false,
    );
  });
});

describe('dayDividerLabel', () => {
  const now = new Date('2026-07-05T15:00:00');

  it('returns the today key for any time on the current local day', () => {
    expect(dayDividerLabel(new Date('2026-07-05T00:10:00'), now, 'en')).toEqual({ key: 'today' });
  });

  it('returns the yesterday key for the previous local day', () => {
    expect(dayDividerLabel(new Date('2026-07-04T23:59:00'), now, 'en')).toEqual({
      key: 'yesterday',
    });
  });

  it('handles yesterday across a month boundary', () => {
    const firstOfMonth = new Date('2026-07-01T09:00:00');
    expect(dayDividerLabel(new Date('2026-06-30T12:00:00'), firstOfMonth, 'en')).toEqual({
      key: 'yesterday',
    });
  });

  it('formats same-year dates without the year', () => {
    expect(dayDividerLabel(new Date('2026-03-11T12:00:00'), now, 'en')).toEqual({
      text: 'March 11',
    });
  });

  it('formats other-year dates with the year', () => {
    expect(dayDividerLabel(new Date('2025-12-30T12:00:00'), now, 'en')).toEqual({
      text: 'December 30, 2025',
    });
  });

  it('formats dates in Spanish when the locale is es', () => {
    expect(dayDividerLabel(new Date('2026-03-11T12:00:00'), now, 'es')).toEqual({
      text: '11 de marzo',
    });
  });
});

describe('resolveNewChatTarget', () => {
  const now = new Date('2026-04-20T15:00:00');
  const today = (h = 10) => new Date(`2026-04-20T${String(h).padStart(2, '0')}:00:00`);
  const lastWeek = new Date('2026-04-13T10:00:00');
  const yesterday = new Date('2026-04-19T23:30:00');

  it('creates fresh when there are no conversations', () => {
    const plan = resolveNewChatTarget([], now);
    expect(plan).toEqual({ reuseId: null, purgeIds: [], createNew: true });
  });

  it('creates fresh when all existing conversations have messages', () => {
    const plan = resolveNewChatTarget(
      [makeConv({ id: 'a', messages: [msg()] }), makeConv({ id: 'b', messages: [msg()] })],
      now,
    );
    expect(plan).toEqual({ reuseId: null, purgeIds: [], createNew: true });
  });

  it('reuses the empty chat from today without creating a new one', () => {
    const plan = resolveNewChatTarget([makeConv({ id: 'today-empty', createdAt: today(10) })], now);
    expect(plan.reuseId).toBe('today-empty');
    expect(plan.createNew).toBe(false);
    expect(plan.purgeIds).toEqual([]);
  });

  it('purges a week-old empty chat and creates a fresh one (the reported bug)', () => {
    const plan = resolveNewChatTarget([makeConv({ id: 'stale', createdAt: lastWeek })], now);
    expect(plan.reuseId).toBe(null);
    expect(plan.createNew).toBe(true);
    expect(plan.purgeIds).toEqual(['stale']);
  });

  it('purges yesterday empty + keeps today non-empties + creates fresh', () => {
    const plan = resolveNewChatTarget(
      [
        makeConv({ id: 'yday-empty', createdAt: yesterday }),
        makeConv({ id: 'today-real', createdAt: today(9), messages: [msg()] }),
      ],
      now,
    );
    expect(plan.reuseId).toBe(null);
    expect(plan.createNew).toBe(true);
    expect(plan.purgeIds).toEqual(['yday-empty']);
  });

  it('reuses newest today-empty and purges older duplicate today-empties', () => {
    // Conversations list is prepend-ordered (newest first).
    const plan = resolveNewChatTarget(
      [
        makeConv({ id: 'newer', createdAt: today(14) }),
        makeConv({ id: 'older-today', createdAt: today(9) }),
      ],
      now,
    );
    expect(plan.reuseId).toBe('newer');
    expect(plan.createNew).toBe(false);
    expect(plan.purgeIds).toEqual(['older-today']);
  });

  it('reuses today-empty and purges unrelated stale empties', () => {
    const plan = resolveNewChatTarget(
      [
        makeConv({ id: 'today', createdAt: today(10) }),
        makeConv({ id: 'last-week', createdAt: lastWeek }),
      ],
      now,
    );
    expect(plan.reuseId).toBe('today');
    expect(plan.createNew).toBe(false);
    expect(plan.purgeIds).toEqual(['last-week']);
  });

  it('never purges a conversation that has messages, no matter how old', () => {
    const plan = resolveNewChatTarget(
      [
        makeConv({ id: 'ancient-real', createdAt: lastWeek, messages: [msg()] }),
        makeConv({ id: 'stale-empty', createdAt: lastWeek }),
      ],
      now,
    );
    expect(plan.purgeIds).toEqual(['stale-empty']);
    expect(plan.purgeIds).not.toContain('ancient-real');
  });
});
