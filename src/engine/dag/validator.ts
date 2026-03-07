/**
 * DAG validator — validates a DAG definition before execution.
 *
 * Three checks:
 * 1. Cycle detection (DFS-based)
 * 2. Action type existence (every step's actionType must be registered)
 * 3. Input mapping validity (sourceStepId must exist and be a transitive dependency)
 */

import type { ActionRegistry } from '../actions/registry';
import type { DAGDefinition, StepDefinition } from './types';

// ── Error class ──────────────────────────────────────────────────

export class DAGValidationError extends Error {
  public details: string[];

  constructor(message: string, details: string[]) {
    super(message);
    this.name = 'DAGValidationError';
    this.details = details;
  }
}

// ── Validation ───────────────────────────────────────────────────

export interface ValidationResult {
  valid: true;
}

/**
 * Validates a DAG definition. Returns `{ valid: true }` or throws DAGValidationError.
 */
export function validateDAG(dag: DAGDefinition, registry: ActionRegistry): ValidationResult {
  const errors: string[] = [];
  const stepMap = new Map<string, StepDefinition>();

  for (const step of dag.steps) {
    if (stepMap.has(step.id)) {
      errors.push(`Duplicate step ID: "${step.id}"`);
    }
    stepMap.set(step.id, step);
  }

  // Check 1: Cycle detection
  const cycleError = detectCycle(dag.steps, stepMap);
  if (cycleError) {
    errors.push(cycleError);
  }

  // Check 2: Action type existence + approval_gate consistency
  for (const step of dag.steps) {
    if (!registry.has(step.actionType)) {
      errors.push(`Step "${step.id}" references unknown action type "${step.actionType}"`);
    }
    if (step.actionType === 'approval_gate' && !step.requiresApproval) {
      errors.push(
        `Step "${step.id}" uses action type "approval_gate" but requiresApproval is not set — ` +
        `approval gates must have requiresApproval: true`
      );
    }
  }

  // Check 3: Input mapping validity
  for (const step of dag.steps) {
    // Check dependsOn references
    for (const depId of step.dependsOn) {
      if (!stepMap.has(depId)) {
        errors.push(`Step "${step.id}" depends on non-existent step "${depId}"`);
      }
    }

    // Check input mappings
    for (const mapping of step.inputMappings) {
      if (!stepMap.has(mapping.sourceStepId)) {
        errors.push(
          `Step "${step.id}" has input mapping from non-existent step "${mapping.sourceStepId}"`
        );
        continue;
      }

      // sourceStepId must be in this step's transitive dependency closure
      const ancestors = getTransitiveDependencies(step.id, stepMap);
      if (!ancestors.has(mapping.sourceStepId)) {
        errors.push(
          `Step "${step.id}" has input mapping from step "${mapping.sourceStepId}" ` +
          `which is not in its dependency chain`
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new DAGValidationError(
      `DAG validation failed with ${errors.length} error(s)`,
      errors,
    );
  }

  return { valid: true };
}

// ── Cycle detection (DFS) ────────────────────────────────────────

type Color = 'white' | 'gray' | 'black';

function detectCycle(
  steps: StepDefinition[],
  stepMap: Map<string, StepDefinition>,
): string | null {
  const color = new Map<string, Color>();
  const parent = new Map<string, string>();

  for (const step of steps) {
    color.set(step.id, 'white');
  }

  for (const step of steps) {
    if (color.get(step.id) === 'white') {
      const cycle = dfsVisit(step.id, stepMap, color, parent);
      if (cycle) return cycle;
    }
  }

  return null;
}

function dfsVisit(
  nodeId: string,
  stepMap: Map<string, StepDefinition>,
  color: Map<string, Color>,
  parent: Map<string, string>,
): string | null {
  color.set(nodeId, 'gray');
  const step = stepMap.get(nodeId);

  if (step) {
    for (const depId of step.dependsOn) {
      if (!stepMap.has(depId)) continue; // skip invalid refs (caught separately)

      const depColor = color.get(depId);
      if (depColor === 'gray') {
        // Found a cycle — reconstruct the path
        return reconstructCyclePath(depId, nodeId, parent);
      }
      if (depColor === 'white') {
        parent.set(depId, nodeId);
        const cycle = dfsVisit(depId, stepMap, color, parent);
        if (cycle) return cycle;
      }
    }
  }

  color.set(nodeId, 'black');
  return null;
}

function reconstructCyclePath(
  cycleStart: string,
  cycleEnd: string,
  parent: Map<string, string>,
): string {
  const path = [cycleStart, cycleEnd];
  let current = cycleEnd;

  while (current !== cycleStart) {
    const p = parent.get(current);
    if (!p) break;
    path.push(p);
    current = p;
  }

  return `Cycle detected: ${path.reverse().join(' -> ')}`;
}

// ── Transitive dependency closure ────────────────────────────────

function getTransitiveDependencies(
  stepId: string,
  stepMap: Map<string, StepDefinition>,
): Set<string> {
  const visited = new Set<string>();
  const stack = [...(stepMap.get(stepId)?.dependsOn ?? [])];

  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const step = stepMap.get(id);
    if (step) {
      for (const depId of step.dependsOn) {
        if (!visited.has(depId)) {
          stack.push(depId);
        }
      }
    }
  }

  return visited;
}
