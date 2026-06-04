import { describe, it, expect } from 'vitest';
import { connectionsNeededForDag } from '../connection-status';
import { validateDagParams } from '../../utils/step-validation';
import type { DAGDefinition } from '../../engine/dag/types';

function dag(
  steps: Array<{
    id?: string;
    name?: string;
    actionType: string;
    params?: Record<string, unknown>;
  }>,
): DAGDefinition {
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

describe('connectionsNeededForDag', () => {
  it('requests github status for a github_* action step', () => {
    const needs = connectionsNeededForDag(
      dag([{ actionType: 'github_create_issue', params: { repo: 'o/r', title: 't' } }]),
    );
    expect(needs).toContain('github');
  });

  it('requests github status when a referenced expert requires github', () => {
    const needs = connectionsNeededForDag(
      dag([{ actionType: 'run_expert', params: { expertId: 'e1', prompt: 'hi' } }]),
      [{ id: 'e1', requiredConnections: ['github'] }],
    );
    expect(needs).toContain('github');
  });

  it('still requests hubspot status for hubspot steps', () => {
    const needs = connectionsNeededForDag(
      dag([{ actionType: 'hubspot_create_ticket', params: { subject: 's' } }]),
    );
    expect(needs).toContain('hubspot');
  });

  it('treats github triggers as inbound, not an outbound connection need', () => {
    const needs = connectionsNeededForDag(
      dag([{ actionType: 'trigger_github_issue_opened', params: {} }]),
    );
    expect(needs).not.toContain('github');
  });

  it('requests no connection probes for a connection-free dag', () => {
    const needs = connectionsNeededForDag(
      dag([{ actionType: 'ask_ai', params: { prompt: 'hi' } }]),
    );
    expect(needs).toHaveLength(0);
  });

  // Regression for #25: the github not-connected guard in validateDagParams
  // only fires when githubConnected === false is actually passed. That value
  // comes from probing the connections connectionsNeededForDag reports, so if
  // github isn't in that list the guard is silently dead on the Run Now path.
  it('lets the github not-connected guard fire end-to-end (regression #25)', () => {
    const d = dag([{ actionType: 'github_create_issue', params: { repo: 'o/r', title: 't' } }]);
    const needs = connectionsNeededForDag(d);
    expect(needs).toContain('github');

    // Simulate the disconnected status the Run Now path would have probed.
    const issues = validateDagParams(d, { githubConnected: false });
    expect(issues.some((i) => i.field === 'connection' && i.message.includes('GitHub'))).toBe(true);
  });
});
