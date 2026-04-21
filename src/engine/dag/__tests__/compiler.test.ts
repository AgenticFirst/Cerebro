import { describe, it, expect } from 'vitest';
import { compileLinearDAG } from '../compiler';

// ── Linear chain ────────────────────────────────────────────────

describe('compileLinearDAG', () => {
  it('compiles 3 steps into a linear chain', () => {
    const dag = compileLinearDAG({
      steps: ['Fetch data', 'Transform data', 'Save results'],
    });

    expect(dag.steps).toHaveLength(3);

    // First step has no dependencies
    expect(dag.steps[0].id).toBe('step_1');
    expect(dag.steps[0].name).toBe('Fetch data');
    expect(dag.steps[0].dependsOn).toEqual([]);
    expect(dag.steps[0].inputMappings).toEqual([]);

    // Second step depends on first — variable name is derived from step 1's name
    expect(dag.steps[1].id).toBe('step_2');
    expect(dag.steps[1].dependsOn).toEqual(['step_1']);
    expect(dag.steps[1].inputMappings).toEqual([
      { sourceStepId: 'step_1', sourceField: 'response', targetField: 'fetch_data' },
    ]);

    // Third step depends on second — variable name is derived from step 2's name
    expect(dag.steps[2].id).toBe('step_3');
    expect(dag.steps[2].dependsOn).toEqual(['step_2']);
    expect(dag.steps[2].inputMappings).toEqual([
      { sourceStepId: 'step_2', sourceField: 'response', targetField: 'transform_data' },
    ]);
  });

  // ── Action type mapping ────────────────────────────────────────

  it('uses ask_ai when no defaultRunnerId', () => {
    const dag = compileLinearDAG({ steps: ['Do something'] });
    expect(dag.steps[0].actionType).toBe('ask_ai');
    expect(dag.steps[0].params).toHaveProperty('prompt', 'Do something');
    expect(dag.steps[0].params).toHaveProperty('system_prompt');
    expect(dag.steps[0].params).toHaveProperty('agent', 'cerebro');
  });

  it('wires the previous step name as a variable into ask_ai prompt for chained steps', () => {
    const dag = compileLinearDAG({ steps: ['Fetch data', 'Transform it'] });
    expect(dag.steps[1].actionType).toBe('ask_ai');
    expect(dag.steps[1].params.prompt).toContain('{{fetch_data}}');
  });

  it('uses expert_step when defaultRunnerId is set', () => {
    const dag = compileLinearDAG({
      steps: ['Do something'],
      defaultRunnerId: 'expert-123',
    });
    expect(dag.steps[0].actionType).toBe('expert_step');
    expect(dag.steps[0].params).toHaveProperty('prompt', 'Do something');
    expect(dag.steps[0].params).toHaveProperty('expertId', 'expert-123');
  });

  it('includes additionalContext for expert_step after first step', () => {
    const dag = compileLinearDAG({
      steps: ['Step A', 'Step B'],
      defaultRunnerId: 'expert-1',
    });
    // First step — no previous context
    expect(dag.steps[0].params.additionalContext).toBeUndefined();
    // Second step — reference uses the sanitized previous step name
    expect(dag.steps[1].params.additionalContext).toBe(
      'Previous step output: {{step_a}}',
    );
  });

  // ── Approval gates ─────────────────────────────────────────────

  it('marks matching steps as requiresApproval', () => {
    const dag = compileLinearDAG({
      steps: ['Gather info', 'Send email', 'Log result'],
      approvalGates: ['Send email'],
    });
    expect(dag.steps[0].requiresApproval).toBe(false);
    expect(dag.steps[1].requiresApproval).toBe(true);
    expect(dag.steps[2].requiresApproval).toBe(false);
  });

  it('approval gate matching is case-insensitive', () => {
    const dag = compileLinearDAG({
      steps: ['SEND EMAIL'],
      approvalGates: ['send email'],
    });
    expect(dag.steps[0].requiresApproval).toBe(true);
  });

  // ── Error policy ───────────────────────────────────────────────

  it('defaults onError to fail', () => {
    const dag = compileLinearDAG({ steps: ['Step'] });
    expect(dag.steps[0].onError).toBe('fail');
  });

  it('propagates custom onError', () => {
    const dag = compileLinearDAG({ steps: ['Step'], onError: 'skip' });
    expect(dag.steps[0].onError).toBe('skip');
  });

  // ── Edge cases ─────────────────────────────────────────────────

  it('handles empty steps array', () => {
    const dag = compileLinearDAG({ steps: [] });
    expect(dag.steps).toEqual([]);
  });

  it('handles single step with no dependencies', () => {
    const dag = compileLinearDAG({ steps: ['Only step'] });
    expect(dag.steps).toHaveLength(1);
    expect(dag.steps[0].dependsOn).toEqual([]);
    expect(dag.steps[0].inputMappings).toEqual([]);
  });

});
