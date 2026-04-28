import { describe, it, expect } from 'vitest';
import { buildRoutineContext } from '../routine-context';
import type { DAGDefinition, StepDefinition } from '../../dag/types';

// ── Helpers ────────────────────────────────────────────────────

function step(overrides: Partial<StepDefinition> & { id: string; actionType: string }): StepDefinition {
  return {
    id: overrides.id,
    name: overrides.name ?? `Step ${overrides.id}`,
    actionType: overrides.actionType,
    params: overrides.params ?? {},
    dependsOn: overrides.dependsOn ?? [],
    inputMappings: overrides.inputMappings ?? [],
    requiresApproval: false,
    onError: 'fail',
  } as StepDefinition;
}

function dag(steps: StepDefinition[]): DAGDefinition {
  return { steps } as DAGDefinition;
}

// ── Tests ─────────────────────────────────────────────────────

describe('buildRoutineContext', () => {
  it('returns empty string for single-step DAG', () => {
    const out = buildRoutineContext(
      dag([step({ id: 'a', actionType: 'run_expert' })]),
      'a',
    );
    expect(out).toBe('');
  });

  it('returns empty string when step has no upstream and no downstream peers', () => {
    const out = buildRoutineContext(
      dag([
        step({ id: 'a', actionType: 'run_expert' }),
        step({ id: 'b', actionType: 'send_message' }), // unrelated, no edges to/from a
      ]),
      'a',
    );
    expect(out).toBe('');
  });

  it('describes a downstream hubspot step with the credential reassurance', () => {
    const out = buildRoutineContext(
      dag([
        step({ id: 'a', actionType: 'run_expert' }),
        step({
          id: 'b',
          name: 'New HubSpot: Create Ticket',
          actionType: 'hubspot_create_ticket',
          inputMappings: [{ sourceStepId: 'a', sourceField: 'response', targetField: 'note' }],
        }),
      ]),
      'a',
    );
    // The exact reason this fix exists: the LLM was asking for an API token.
    expect(out).toContain('do NOT need to ask for an API token');
    expect(out).toContain('HubSpot');
    expect(out).toContain('subject and body');
  });

  it('lists multiple downstream steps in order', () => {
    const out = buildRoutineContext(
      dag([
        step({ id: 'a', actionType: 'run_expert' }),
        step({
          id: 'b',
          name: 'Notify',
          actionType: 'send_notification',
          inputMappings: [{ sourceStepId: 'a', sourceField: 'response', targetField: 'body' }],
        }),
        step({
          id: 'c',
          name: 'Create Ticket',
          actionType: 'hubspot_create_ticket',
          inputMappings: [{ sourceStepId: 'a', sourceField: 'response', targetField: 'content' }],
        }),
      ]),
      'a',
    );
    expect(out).toContain('Notify');
    expect(out).toContain('Create Ticket');
    expect(out.indexOf('Notify')).toBeLessThan(out.indexOf('Create Ticket'));
  });

  it('describes upstream steps the expert receives input from', () => {
    const out = buildRoutineContext(
      dag([
        step({ id: 'a', name: 'Search Memory', actionType: 'search_memory' }),
        step({
          id: 'b',
          name: 'Run Expert',
          actionType: 'run_expert',
          inputMappings: [{ sourceStepId: 'a', sourceField: 'results', targetField: 'memory' }],
        }),
      ]),
      'b',
    );
    expect(out).toContain('Upstream steps');
    expect(out).toContain('Search Memory');
  });

  it('uses dependsOn even without input mappings', () => {
    const out = buildRoutineContext(
      dag([
        step({ id: 'a', actionType: 'run_expert' }),
        step({ id: 'b', name: 'Fire-and-forget', actionType: 'send_notification', dependsOn: ['a'] }),
      ]),
      'a',
    );
    expect(out).toContain('Fire-and-forget');
  });

  it('includes the do-not-call-APIs system instruction at the top', () => {
    const out = buildRoutineContext(
      dag([
        step({ id: 'a', actionType: 'run_expert' }),
        step({
          id: 'b',
          actionType: 'send_telegram_message',
          inputMappings: [{ sourceStepId: 'a', sourceField: 'response', targetField: 'message' }],
        }),
      ]),
      'a',
    );
    expect(out).toMatch(/Workflow context/);
    expect(out).toMatch(/do NOT attempt to perform actions/i);
    expect(out).toMatch(/credentials/);
  });

  it('handles unknown action types with a generic description', () => {
    const out = buildRoutineContext(
      dag([
        step({ id: 'a', actionType: 'run_expert' }),
        step({
          id: 'b',
          name: 'Custom',
          actionType: 'my_custom_action',
          dependsOn: ['a'],
        }),
      ]),
      'a',
    );
    expect(out).toContain('Custom');
    expect(out).toContain('my custom action');
  });

  it('respects the legacy expert_step alias resolution', () => {
    // Action type alias from step-defaults.ts. The downstream step's
    // description should resolve through resolveActionType so the
    // legacy and current forms produce identical output.
    const a = buildRoutineContext(
      dag([
        step({ id: 's', actionType: 'http_request' }),
        step({ id: 'd', actionType: 'expert_step', dependsOn: ['s'] }),
      ]),
      's',
    );
    const b = buildRoutineContext(
      dag([
        step({ id: 's', actionType: 'http_request' }),
        step({ id: 'd', actionType: 'run_expert', dependsOn: ['s'] }),
      ]),
      's',
    );
    expect(a).toBe(b);
  });

  it('regression: the exact Test Hubspot routine produces the right hint', () => {
    // This is the user-reported failure: the expert at step 1 didn't
    // know step 2 would create the HubSpot ticket and asked for an
    // API token. With this context block, the LLM should produce
    // a draft subject + body instead.
    const out = buildRoutineContext(
      dag([
        step({
          id: 'c0732875-1806-40d4-b34c-0a8957618bdb',
          name: 'New Run Expert',
          actionType: 'run_expert',
          params: { expertId: 'expert-1', prompt: 'Create a test ticket in hubspot' },
        }),
        step({
          id: '212e863c-48c5-4880-a6ed-0c8cdf6fa906',
          name: 'New HubSpot: Create Ticket',
          actionType: 'hubspot_create_ticket',
          dependsOn: ['c0732875-1806-40d4-b34c-0a8957618bdb'],
          inputMappings: [
            {
              sourceStepId: 'c0732875-1806-40d4-b34c-0a8957618bdb',
              sourceField: 'response',
              targetField: 'new_run_expert',
            },
          ],
        }),
      ]),
      'c0732875-1806-40d4-b34c-0a8957618bdb',
    );
    expect(out).toContain('New HubSpot: Create Ticket');
    expect(out).toContain('HubSpot');
    expect(out).toContain('do NOT need to ask for an API token');
    expect(out).toContain('subject and body');
  });
});
