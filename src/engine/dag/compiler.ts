/**
 * Linear DAG compiler — converts plain-english steps into a sequential DAG.
 * Pure function, no Node.js deps — safe for renderer import.
 */

import type { DAGDefinition, StepDefinition, InputMapping } from './types';

interface CompileOptions {
  steps: string[];
  defaultRunnerId?: string;
  approvalGates?: string[];
  onError?: 'fail' | 'skip' | 'retry';
}

/**
 * Compile a list of plain-english steps into a linear DAG where each step
 * depends on the previous one. Steps are mapped to `model_call` (no runner)
 * or `expert_step` (with runner).
 */
export function compileLinearDAG(options: CompileOptions): DAGDefinition {
  const { steps, defaultRunnerId, approvalGates = [], onError = 'fail' } = options;
  const gateSet = new Set(approvalGates.map((g) => g.toLowerCase()));

  const dagSteps: StepDefinition[] = steps.map((stepText, i) => {
    const id = `step_${i + 1}`;
    const prevId = i > 0 ? `step_${i}` : undefined;

    const dependsOn: string[] = prevId ? [prevId] : [];
    const inputMappings: InputMapping[] = prevId
      ? [{ sourceStepId: prevId, sourceField: 'response', targetField: 'previous_output' }]
      : [];

    const actionType = defaultRunnerId ? 'expert_step' : 'model_call';
    const params: Record<string, unknown> =
      actionType === 'expert_step'
        ? {
            prompt: stepText,
            expertId: defaultRunnerId,
            additionalContext: prevId
              ? 'Previous step output: {{previous_output}}'
              : undefined,
          }
        : {
            prompt: stepText,
            systemPrompt: 'You are executing a step in a routine. Complete the task described.',
          };

    return {
      id,
      name: stepText,
      actionType,
      params,
      dependsOn,
      inputMappings,
      requiresApproval: gateSet.has(stepText.toLowerCase()),
      onError,
    };
  });

  return { steps: dagSteps };
}
