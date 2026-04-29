/**
 * DAG type definitions for the execution engine.
 *
 * A DAG (Directed Acyclic Graph) defines a set of steps with dependencies.
 * Steps run in topological order, with independent steps executing in parallel.
 */

// ── Step Definition ──────────────────────────────────────────────

export interface StepDefinition {
  /** Unique identifier for this step within the DAG. */
  id: string;

  /** Human-readable name displayed in the UI. */
  name: string;

  /** Which action type to execute (e.g. 'model_call', 'transformer', 'expert_step'). */
  actionType: string;

  /** Action-specific parameters. */
  params: Record<string, unknown>;

  /** IDs of steps that must complete before this one starts. */
  dependsOn: string[];

  /** Maps output fields from dependency steps into this step's wiredInputs. */
  inputMappings: InputMapping[];

  /** Whether this step requires human approval before execution (Phase 5). */
  requiresApproval: boolean;

  /** Error handling policy. */
  onError: 'fail' | 'skip' | 'retry';

  /** Max retry attempts when onError is 'retry'. Default: 1. */
  maxRetries?: number;

  /** Step timeout in milliseconds. Default: 300_000 (5 min). */
  timeoutMs?: number;
}

// ── Input Mapping ────────────────────────────────────────────────

export interface InputMapping {
  /** ID of the step whose output to read from. */
  sourceStepId: string;

  /** Dot-path into the source step's output.data (e.g. "result" or "response"). */
  sourceField: string;

  /** Key in this step's wiredInputs where the value is placed. */
  targetField: string;

  /** Only wire when source condition step's branch output matches. Used for if/else branching. */
  branchCondition?: 'true' | 'false';
}

// ── DAG Definition ───────────────────────────────────────────────

export interface DAGDefinition {
  steps: StepDefinition[];
}

// ── Engine Run Request ───────────────────────────────────────────

export interface EngineRunRequest {
  dag: DAGDefinition;

  /** Optional reference to the routine definition. */
  routineId?: string;

  /** How this run was triggered: 'manual' | 'schedule' | 'chat' | 'telegram_message'. */
  triggerSource?: string;

  /** Payload from the trigger event (e.g. inbound Telegram message fields).
   *  Made available to steps as a synthetic '__trigger__' step output, so
   *  inputMappings with sourceStepId='__trigger__' can read individual fields. */
  triggerPayload?: Record<string, unknown>;

  /** Run type tag persisted on the run record. Defaults to 'routine'.
   *  Chat-triggered single-action runs use 'chat_action'. */
  runType?: 'routine' | 'preview' | 'ad_hoc' | 'orchestration' | 'task' | 'chat_action';

  /** Dry-run mode: side-effecty actions are replaced with synthetic-success
   *  stubs and approval gates auto-pass, so the routine's wiring, schemas,
   *  and templates can be verified end-to-end without real API calls.
   *  Used by the propose-routine flow before persisting a Cerebro-drafted
   *  routine to disk. */
  dryRun?: boolean;
}
