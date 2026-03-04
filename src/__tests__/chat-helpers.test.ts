import { describe, it, expect } from 'vitest';
import { generateId, titleFromContent, fromApiConversation, fromApiMessage } from '../context/chat-helpers';
import type { ApiConversation, ApiMessage } from '../context/chat-helpers';

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
});
