import { describe, it, expect } from 'vitest';
import { validateDagParams, type ValidationContext } from '../utils/step-validation';
import type { DAGDefinition } from '../engine/dag/types';

// ── Helpers ────────────────────────────────────────────────────

function dag(steps: Array<{
  id?: string;
  name?: string;
  actionType: string;
  params?: Record<string, unknown>;
}>): DAGDefinition {
  return {
    steps: steps.map((s, i) => ({
      id: s.id ?? `step-${i}`,
      name: s.name ?? `Step ${i}`,
      actionType: s.actionType,
      params: s.params ?? {},
      dependsOn: [],
      inputMappings: [],
      requiresApproval: false,
      onError: 'fail',
    })),
  } as DAGDefinition;
}

const expert = (overrides: Partial<{ id: string; isEnabled: boolean; requiredConnections: string[] | null }> = {}) => ({
  id: 'expert-1',
  isEnabled: true,
  requiredConnections: null,
  ...overrides,
});

// ── run_expert ─────────────────────────────────────────────────

describe('validateDagParams: run_expert', () => {
  it('flags blank expertId', () => {
    const issues = validateDagParams(dag([{ actionType: 'run_expert', params: { expertId: '', prompt: 'hi' } }]));
    expect(issues.some((i) => i.field === 'expertId' && i.message.includes('pick an expert'))).toBe(true);
  });

  it('flags blank prompt', () => {
    const issues = validateDagParams(dag([{ actionType: 'run_expert', params: { expertId: 'x', prompt: '' } }]));
    expect(issues.some((i) => i.field === 'prompt')).toBe(true);
  });

  it('flags whitespace-only fields as blank', () => {
    const issues = validateDagParams(dag([{ actionType: 'run_expert', params: { expertId: '  ', prompt: '   \n  ' } }]));
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });

  it('flags expert missing from context', () => {
    const issues = validateDagParams(
      dag([{ actionType: 'run_expert', params: { expertId: 'ghost', prompt: 'hi' } }]),
      { experts: [expert({ id: 'real' })] },
    );
    expect(issues.some((i) => i.message.includes('no longer exists'))).toBe(true);
  });

  it('flags disabled expert', () => {
    const issues = validateDagParams(
      dag([{ actionType: 'run_expert', params: { expertId: 'e1', prompt: 'hi' } }]),
      { experts: [expert({ id: 'e1', isEnabled: false })] },
    );
    expect(issues.some((i) => i.message.includes('disabled'))).toBe(true);
  });

  it('flags missing required connections', () => {
    const issues = validateDagParams(
      dag([{ actionType: 'run_expert', params: { expertId: 'e1', prompt: 'hi' } }]),
      {
        experts: [expert({ id: 'e1', requiredConnections: ['hubspot', 'telegram'] })],
        hubspotConnected: false,
        telegramConnected: true,
      },
    );
    expect(issues.some((i) => i.message.includes('HubSpot'))).toBe(true);
    expect(issues.some((i) => i.message.includes('Telegram'))).toBe(false);
  });

  it('passes when expert exists, enabled, connections satisfied, prompt set', () => {
    const issues = validateDagParams(
      dag([{ actionType: 'run_expert', params: { expertId: 'e1', prompt: 'hi', model: 'claude-sonnet-4-6' } }]),
      {
        experts: [expert({ id: 'e1', requiredConnections: ['hubspot'] })],
        hubspotConnected: true,
        knownModels: ['claude-sonnet-4-6'],
      },
    );
    expect(issues).toEqual([]);
  });

  it('flags unknown model when knownModels is provided', () => {
    const issues = validateDagParams(
      dag([{ actionType: 'run_expert', params: { expertId: 'e1', prompt: 'hi', model: 'gpt-99' } }]),
      { experts: [expert({ id: 'e1' })], knownModels: ['claude-sonnet-4-6'] },
    );
    expect(issues.some((i) => i.field === 'model')).toBe(true);
  });

  it('catches the legacy expert_step alias', () => {
    const issues = validateDagParams(dag([{ actionType: 'expert_step', params: { expertId: '', prompt: '' } }]));
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });

  it('catches the EXACT misconfiguration that produced the original 5-min hang', () => {
    // This is the failing routine from the bug report — every required field blank.
    const issues = validateDagParams(
      dag([
        { id: 'a', name: 'New Run Expert', actionType: 'run_expert', params: { expertId: '', prompt: '' } },
        { id: 'b', name: 'New HubSpot: Create Ticket', actionType: 'hubspot_create_ticket', params: { subject: '' } },
      ]),
      { experts: [], hubspotConnected: true },
    );
    // Three discrete issues should fire: expert, prompt, subject.
    expect(issues.some((i) => i.message.includes('pick an expert'))).toBe(true);
    expect(issues.some((i) => i.field === 'prompt')).toBe(true);
    expect(issues.some((i) => i.message.includes('subject'))).toBe(true);
  });
});

// ── HubSpot ─────────────────────────────────────────────────────

describe('validateDagParams: hubspot_*', () => {
  it('flags blank hubspot_create_ticket subject', () => {
    const issues = validateDagParams(dag([{ actionType: 'hubspot_create_ticket', params: { subject: '' } }]));
    expect(issues.some((i) => i.message.includes('subject'))).toBe(true);
  });

  it('flags HubSpot disconnected', () => {
    const issues = validateDagParams(
      dag([{ actionType: 'hubspot_create_ticket', params: { subject: 'X' } }]),
      { hubspotConnected: false },
    );
    expect(issues.some((i) => i.message.includes('connect HubSpot'))).toBe(true);
  });

  it('does not flag HubSpot when connected', () => {
    const issues = validateDagParams(
      dag([{ actionType: 'hubspot_create_ticket', params: { subject: 'X' } }]),
      { hubspotConnected: true },
    );
    expect(issues).toEqual([]);
  });

  it('flags hubspot_upsert_contact missing email', () => {
    const issues = validateDagParams(
      dag([{ actionType: 'hubspot_upsert_contact', params: { email: '' } }]),
      { hubspotConnected: true },
    );
    expect(issues.some((i) => i.field === 'email')).toBe(true);
  });
});

// ── Other action types ─────────────────────────────────────────

describe('validateDagParams: other action types', () => {
  it('flags blank ask_ai prompt', () => {
    const issues = validateDagParams(dag([{ actionType: 'ask_ai', params: { prompt: '' } }]));
    expect(issues.some((i) => i.field === 'prompt')).toBe(true);
  });

  it('flags blank send_notification title', () => {
    const issues = validateDagParams(dag([{ actionType: 'send_notification', params: { title: '' } }]));
    expect(issues.some((i) => i.field === 'title')).toBe(true);
  });

  it('flags blank http_request URL', () => {
    const issues = validateDagParams(dag([{ actionType: 'http_request', params: { url: '' } }]));
    expect(issues.some((i) => i.field === 'url')).toBe(true);
  });

  it('flags telegram missing chat_id and message', () => {
    const issues = validateDagParams(
      dag([{ actionType: 'send_telegram_message', params: { chat_id: '', message: '' } }]),
    );
    expect(issues.length).toBe(2);
  });

  it('does not flag action types not in the validation list', () => {
    const issues = validateDagParams(dag([{ actionType: 'condition', params: {} }]));
    expect(issues).toEqual([]);
  });
});

// ── Run-level: Claude Code auth ────────────────────────────────

describe('validateDagParams: claude code auth', () => {
  it('flags unauthenticated Claude Code when DAG uses run_expert', () => {
    const issues = validateDagParams(
      dag([{ actionType: 'run_expert', params: { expertId: 'e1', prompt: 'hi' } }]),
      { experts: [expert({ id: 'e1' })], claudeCodeAuthChecked: true, claudeCodeAuthOk: false, claudeCodeAuthReason: 'timed out' },
    );
    expect(issues.some((i) => i.field === 'auth')).toBe(true);
    expect(issues.some((i) => i.message.includes("Run `claude`"))).toBe(true);
    expect(issues.some((i) => i.message.includes('timed out'))).toBe(true);
  });

  it('does not flag auth when DAG has no Claude-Code-using action', () => {
    const issues = validateDagParams(
      dag([{ actionType: 'http_request', params: { url: 'https://x.test' } }]),
      { claudeCodeAuthChecked: true, claudeCodeAuthOk: false },
    );
    expect(issues.some((i) => i.field === 'auth')).toBe(false);
  });

  it('skips auth check when caller did not run the probe', () => {
    const issues = validateDagParams(
      dag([{ actionType: 'run_expert', params: { expertId: 'e1', prompt: 'hi' } }]),
      { experts: [expert({ id: 'e1' })] },
    );
    expect(issues.some((i) => i.field === 'auth')).toBe(false);
  });

  it('does not flag auth when probe succeeded', () => {
    const issues = validateDagParams(
      dag([{ actionType: 'run_expert', params: { expertId: 'e1', prompt: 'hi' } }]),
      { experts: [expert({ id: 'e1' })], claudeCodeAuthChecked: true, claudeCodeAuthOk: true },
    );
    expect(issues.some((i) => i.field === 'auth')).toBe(false);
  });
});

// ── Multi-step DAGs ────────────────────────────────────────────

describe('validateDagParams: multi-step', () => {
  it('reports issues from every broken step', () => {
    const issues = validateDagParams(
      dag([
        { actionType: 'run_expert', params: { expertId: '', prompt: '' } },
        { actionType: 'http_request', params: { url: '' } },
        { actionType: 'send_notification', params: { title: 'OK' } },
      ]),
    );
    // 2 from run_expert, 1 from http_request, 0 from send_notification = 3
    expect(issues.length).toBe(3);
  });

  it('returns empty for a valid multi-step DAG', () => {
    const issues = validateDagParams(
      dag([
        { actionType: 'run_expert', params: { expertId: 'e1', prompt: 'hi' } },
        { actionType: 'hubspot_create_ticket', params: { subject: 'T' } },
      ]),
      { experts: [expert({ id: 'e1' })], hubspotConnected: true },
    );
    expect(issues).toEqual([]);
  });
});

// ── Edge cases ─────────────────────────────────────────────────

describe('validateDagParams: edge cases', () => {
  it('handles missing params object', () => {
    const issues = validateDagParams(
      { steps: [{ id: 'a', name: 'X', actionType: 'run_expert', dependsOn: [], inputMappings: [], requiresApproval: false, onError: 'fail' }] } as unknown as DAGDefinition,
    );
    expect(issues.length).toBeGreaterThan(0);
  });

  it('handles non-string param values gracefully (treated as blank)', () => {
    const issues = validateDagParams(
      dag([{ actionType: 'run_expert', params: { expertId: 123 as unknown, prompt: null as unknown } }]),
    );
    expect(issues.some((i) => i.field === 'expertId')).toBe(true);
    expect(issues.some((i) => i.field === 'prompt')).toBe(true);
  });

  it('returns empty issues for empty DAG', () => {
    const issues = validateDagParams({ steps: [] } as DAGDefinition);
    expect(issues).toEqual([]);
  });

  it('preserves stepId and stepName so the toast can name the offender', () => {
    const issues = validateDagParams(
      dag([{ id: 'abc-123', name: 'Pick Customer', actionType: 'run_expert', params: { expertId: '', prompt: '' } }]),
    );
    expect(issues.every((i) => i.stepId === 'abc-123')).toBe(true);
    expect(issues.every((i) => i.stepName === 'Pick Customer')).toBe(true);
  });
});
