/**
 * Linear DAG compiler — converts plain-english steps into a sequential DAG.
 * Pure function, no Node.js deps — safe for renderer import.
 */

import type { DAGDefinition, StepDefinition, InputMapping } from './types';
import { sanitizeVarName } from '../../utils/action-outputs';

interface CompileOptions {
  steps: string[];
  defaultRunnerId?: string;
  approvalGates?: string[];
  onError?: 'fail' | 'skip' | 'retry';
}

/**
 * Fall back for step names whose sanitized form is empty (e.g. a prompt
 * that's all emoji/punctuation). Keeps the compiled variable name stable
 * across compilations by pinning to the step index.
 */
function varNameForStep(name: string, index: number): string {
  return sanitizeVarName(name) || `step_${index + 1}`;
}

/**
 * Compile a list of plain-english steps into a linear DAG where each step
 * depends on the previous one. Steps are mapped to `ask_ai` (no runner)
 * or `expert_step` (with runner).
 */
export function compileLinearDAG(options: CompileOptions): DAGDefinition {
  const { steps, defaultRunnerId, approvalGates = [], onError = 'fail' } = options;
  const gateSet = new Set(approvalGates.map((g) => g.toLowerCase()));

  const dagSteps: StepDefinition[] = steps.map((stepText, i) => {
    const id = `step_${i + 1}`;
    const prevId = i > 0 ? `step_${i}` : undefined;
    const prevVar = i > 0 ? varNameForStep(steps[i - 1], i - 1) : '';

    const dependsOn: string[] = prevId ? [prevId] : [];
    const inputMappings: InputMapping[] = prevId
      ? [{ sourceStepId: prevId, sourceField: 'response', targetField: prevVar }]
      : [];

    const actionType = defaultRunnerId ? 'expert_step' : 'ask_ai';
    const params: Record<string, unknown> =
      actionType === 'expert_step'
        ? {
            prompt: stepText,
            expertId: defaultRunnerId,
            additionalContext: prevId
              ? `Previous step output: {{${prevVar}}}`
              : undefined,
          }
        : {
            prompt: prevId
              ? `${stepText}\n\nPrevious step output:\n{{${prevVar}}}`
              : stepText,
            system_prompt: 'You are executing a step in a routine. Complete the task described.',
            agent: 'cerebro',
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
