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

export type ChatActionAvailability = 'available' | 'not_connected' | 'unavailable';

export interface ChatActionExample {
  en: string;
  es: string;
}

export interface ActionDefinition {
  type: string;
  name: string;
  description: string;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  execute: (input: ActionInput) => Promise<ActionOutput>;

  /**
   * Chat-exposability metadata. When `chatExposable` is true the action is
   * surfaced through the `/chat-actions/catalog` endpoint and the main
   * Cerebro chat can invoke it via the `run-chat-action` skill. Routine
   * control-flow actions (loop, condition, delay, expert_step, etc.) leave
   * this undefined and stay routine-only.
   */
  chatExposable?: boolean;
  /** Human-readable label used in the Help modal and chat catalog. */
  chatLabel?: { en: string; es: string };
  /** Sentence used to describe the action to the model and the user. */
  chatDescription?: { en: string; es: string };
  /** Sample phrasings the user might say in EN or ES. */
  chatExamples?: ChatActionExample[];
  /**
   * Returns whether the action can run right now. Channel-bound actions
   * (HubSpot/Telegram/WhatsApp) check whether the underlying channel is
   * connected; provider-free actions always return `'available'`.
   */
  availabilityCheck?: () => ChatActionAvailability;
  /** Optional integration grouping key used for the Help modal layout. */
  chatGroup?: string;
  /** Optional setup pointer the UI can deep-link to when not_connected. */
  setupHref?: string;
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
  /**
   * Read-only access to the full DAG this step is part of. Used by
   * `run_expert` to inject routine-shape context into the agent's
   * prompt (so an expert running as step 1 of a 2-step routine knows
   * step 2 will create the HubSpot ticket and shouldn't try to call
   * the HubSpot API itself). Optional: PTY-only or telemetry-style
   * actions that don't need the surrounding workflow can ignore it.
   */
  dag?: import('../dag/types').DAGDefinition;
}
