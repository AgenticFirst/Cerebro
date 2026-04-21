/**
 * Output metadata for each action type — what a downstream step can reference.
 *
 * The canvas auto-wires a new edge using `primary: true` so connecting two
 * nodes never produces a silent "nothing bound" state. Secondary fields are
 * offered in the chip menu for actions that emit more than one useful value.
 *
 * Keep the field names aligned with the Python adapters that populate
 * `output.data` — these are the exact keys the engine will resolve at runtime.
 */

import type { RoutineStepData } from './dag-flow-mapping';

export interface OutputField {
  /** Field path under output.data. Empty string means "the whole data object". */
  field: string;
  /** Exactly one per action is marked primary — it's used on auto-wire. */
  primary?: boolean;
  /** Short human label for chip tooltips. */
  label: string;
}

export const ACTION_OUTPUTS: Record<string, OutputField[]> = {
  ask_ai: [{ field: 'response', primary: true, label: 'AI reply' }],
  run_expert: [{ field: 'response', primary: true, label: 'Expert reply' }],
  summarize: [{ field: 'summary', primary: true, label: 'Summary' }],
  classify: [
    { field: 'category', primary: true, label: 'Category' },
    { field: 'confidence', label: 'Confidence' },
    { field: 'reasoning', label: 'Reasoning' },
  ],
  extract: [{ field: '', primary: true, label: 'Extracted data' }],
  search_web: [
    { field: 'ai_answer', primary: true, label: 'AI answer' },
    { field: 'results', label: 'Results list' },
  ],
  search_memory: [{ field: 'results', primary: true, label: 'Memory matches' }],
  run_command: [
    { field: 'stdout', primary: true, label: 'Output' },
    { field: 'stderr', label: 'Errors' },
    { field: 'exit_code', label: 'Exit code' },
  ],
  run_script: [{ field: '', primary: true, label: 'Script output' }],
  run_claude_code: [{ field: 'response', primary: true, label: 'Claude reply' }],
  http_request: [
    { field: 'body', primary: true, label: 'Response body' },
    { field: 'status', label: 'Status code' },
    { field: 'headers', label: 'Headers' },
  ],
};

/** The pre-wired field for auto-connect. */
export function getPrimaryOutput(actionType: string): OutputField | undefined {
  return ACTION_OUTPUTS[actionType]?.find((f) => f.primary);
}

/** All declared outputs for an action, or empty if it produces nothing useful downstream. */
export function getAllOutputs(actionType: string): OutputField[] {
  return ACTION_OUTPUTS[actionType] ?? [];
}

/**
 * Convert a step name into a safe Mustache key.
 * "Ask AI about weather" → "ask_ai_about_weather".
 * Returns "" if the name has no alphanumeric characters — callers should fall
 * back to a step-id-based default in that case.
 */
export function sanitizeVarName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Produce a targetField that doesn't collide with existing mappings on the same
 * node. Suffix with a short step-id prefix when we need to disambiguate.
 */
export function uniqueVarName(
  base: string,
  existing: RoutineStepData['inputMappings'],
  stepIdForFallback: string = '',
): string {
  const mappings = existing ?? [];
  let candidate = base;
  if (!candidate) {
    candidate = `step_${stepIdForFallback.slice(0, 4) || 'in'}`;
  }
  if (!mappings.some((m) => m.targetField === candidate)) return candidate;

  const suffix = stepIdForFallback.slice(0, 4);
  if (suffix) {
    const suffixed = `${candidate}_${suffix}`;
    if (!mappings.some((m) => m.targetField === suffixed)) return suffixed;
  }
  let i = 2;
  while (mappings.some((m) => m.targetField === `${candidate}_${i}`)) i++;
  return `${candidate}_${i}`;
}

/**
 * Compute the mapping to auto-wire when a new edge is created from `source`
 * into a node with `existingMappings`. Returns null when the source has no
 * declared primary output (triggers, terminal actions) or the mapping would
 * duplicate an existing one — in both cases the caller should leave state
 * alone.
 */
export function computeAutoWireMapping(
  source: { id: string; name: string; actionType: string },
  existingMappings: RoutineStepData['inputMappings'],
): { sourceStepId: string; sourceField: string; targetField: string } | null {
  const primary = getPrimaryOutput(source.actionType);
  if (!primary) return null;

  const mappings = existingMappings ?? [];
  const duplicate = mappings.some(
    (m) => m.sourceStepId === source.id && m.sourceField === primary.field,
  );
  if (duplicate) return null;

  const targetField = uniqueVarName(sanitizeVarName(source.name), mappings, source.id);
  return {
    sourceStepId: source.id,
    sourceField: primary.field,
    targetField,
  };
}
