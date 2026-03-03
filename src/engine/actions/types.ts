/**
 * Core types for the Action system.
 *
 * Every action type implements ActionDefinition. Actions are pure functions:
 * given inputs and context, produce outputs. Side effects (LLM calls, HTTP
 * requests) happen through the context.
 */

import type { RunScratchpad } from '../scratchpad';
import type { ResolvedModel } from '../../agents/types';

// ── Execution Events (minimal — Phase 2 defines the full union) ─

export type ExecutionEvent = {
  type: string;
  [key: string]: unknown;
};

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
  emitEvent: (event: ExecutionEvent) => void;
  resolveModel: () => Promise<ResolvedModel | null>;
}

// ── Re-exports for convenience ──────────────────────────────────

export type { ResolvedModel };
