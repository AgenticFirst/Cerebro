/**
 * Core types for the Action system.
 *
 * Every action type implements ActionDefinition. Actions are pure functions:
 * given inputs and context, produce outputs. Side effects (LLM calls, HTTP
 * requests) happen through the context.
 */

import type { RunScratchpad } from '../scratchpad';

// ── Execution Events (full union from Phase 2) ──────────────────

export type { ExecutionEvent } from '../events/types';

// ── JSON Schema placeholder ─────────────────────────────────────

export type JSONSchema = Record<string, unknown>;

// ── Action Definition ───────────────────────────────────────────

export interface ActionDefinition {
  type: string;
  name: string;
  description: string;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  execute: (input: ActionInput) => Promise<ActionOutput>;
}

// ── Action I/O ──────────────────────────────────────────────────

export interface ActionInput {
  params: Record<string, unknown>;
  wiredInputs: Record<string, unknown>;
  scratchpad: RunScratchpad;
  context: ActionContext;
}

export interface ActionOutput {
  data: Record<string, unknown>;
  summary: string;
}

// ── Action Context ──────────────────────────────────────────────

export interface ActionContext {
  runId: string;
  stepId: string;
  backendPort: number;
  signal: AbortSignal;
  log: (message: string) => void;
  emitEvent: (event: import('../events/types').ExecutionEvent) => void;
}
