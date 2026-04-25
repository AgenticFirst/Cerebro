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
 *
 * `extraValidSourceIds` is for synthetic step ids that don't appear in
 * `dag.steps` but are valid `dependsOn` / `inputMappings.sourceStepId`
 * targets at runtime. Today the only one is `'__trigger__'` (seeded by the
 * executor when a trigger payload is present) — passing it here keeps the
 * validator in sync with the engine's sanitizer + the executor, which both
 * already treat `__trigger__` as a real source when the trigger fires.
 */
export function validateDAG(
  dag: DAGDefinition,
  registry: ActionRegistry,
  extraValidSourceIds: ReadonlySet<string> = new Set(),
): ValidationResult {
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

  // Check 2: Action type existence + type-specific consistency
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
    // Condition must have field and operator
    if (step.actionType === 'condition') {
      const p = step.params;
      if (!p.field) errors.push(`Step "${step.id}" (condition) requires a "field" parameter`);
      if (!p.operator) errors.push(`Step "${step.id}" (condition) requires an "operator" parameter`);
    }
    // Run command must have command
    if (step.actionType === 'run_command') {
      if (!step.params.command) errors.push(`Step "${step.id}" (run_command) requires a "command" parameter`);
    }
    // Run script must have code
    if (step.actionType === 'run_script') {
      if (!step.params.code) errors.push(`Step "${step.id}" (run_script) requires a "code" parameter`);
    }
    // HTTP request must have url
    if (step.actionType === 'http_request') {
      if (!step.params.url) errors.push(`Step "${step.id}" (http_request) requires a "url" parameter`);
    }
  }

  // Check 3: Input mapping validity
  for (const step of dag.steps) {
    // Check dependsOn references
    for (const depId of step.dependsOn) {
      if (!stepMap.has(depId) && !extraValidSourceIds.has(depId)) {
        errors.push(`Step "${step.id}" depends on non-existent step "${depId}"`);
      }
    }

    // Check input mappings
    for (const mapping of step.inputMappings) {
      // Synthetic sources (e.g. `__trigger__`) are always satisfied — the
      // executor seeds them before any step runs, so the transitive-ancestor
      // check below doesn't apply.
      if (extraValidSourceIds.has(mapping.sourceStepId)) continue;

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
    // Embed the full details in `.message` so they survive Electron IPC
    // serialization — custom error fields (`.details`) are dropped across
    // the ipcMain/ipcRenderer boundary, leaving the renderer with only
    // `.name` and `.message` to show the user.
    const bullets = errors.map((e) => `  • ${e}`).join('\n');
    throw new DAGValidationError(
      `DAG validation failed with ${errors.length} error(s):\n${bullets}`,
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
