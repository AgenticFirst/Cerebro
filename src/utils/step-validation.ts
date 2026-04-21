/**
 * Pre-run validation for required step params. The backend enforces these
 * too, but catching them here lets us abort "Run Now" with a targeted
 * toast instead of surfacing a generic failure deep in the run log.
 *
 * Only action types whose missing params produce a silent/confusing run
 * failure belong here — keep the list tight and aligned with the inline
 * validation in StepConfigPanel.
 */

import { resolveActionType } from './step-defaults';
import type { DAGDefinition } from '../engine/dag/types';

export interface StepValidationIssue {
  stepId: string;
  stepName: string;
  field: string;
  message: string;
}

function isBlank(v: unknown): boolean {
  return typeof v !== 'string' || v.trim().length === 0;
}

export function validateDagParams(dag: DAGDefinition): StepValidationIssue[] {
  const issues: StepValidationIssue[] = [];
  for (const step of dag.steps) {
    const resolved = resolveActionType(step.actionType);
    const p = step.params ?? {};
    if (resolved === 'ask_ai' && isBlank(p.prompt)) {
      issues.push({
        stepId: step.id,
        stepName: step.name,
        field: 'prompt',
        message: `"${step.name}" (Ask AI) is missing a prompt`,
      });
    }
    if (resolved === 'send_notification' && isBlank(p.title)) {
      issues.push({
        stepId: step.id,
        stepName: step.name,
        field: 'title',
        message: `"${step.name}" (Desktop Notification) is missing a headline`,
      });
    }
  }
  return issues;
}
