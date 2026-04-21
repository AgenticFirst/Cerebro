/**
 * Execution Engine — barrel exports.
 *
 * Phase 1: Action infrastructure (individual action execution).
 * Phase 2: DAG executor with topological ordering and event streaming.
 */

// Scratchpad
export { RunScratchpad } from './scratchpad';

// Shared utilities
export { extractByPath, parsePath } from './utils';

// Actions
export {
  ActionRegistry,
  askAiAction,
  modelCallAction,
  transformerAction,
  createExpertStepAction,
  connectorAction,
  channelAction,
} from './actions';

export type {
  ActionDefinition,
  ActionInput,
  ActionOutput,
  ActionContext,
  ExecutionEvent,
  JSONSchema,
  ExpertStepContext,
  ConnectorParams,
  ConnectorOutput,
  ChannelParams,
  ChannelOutput,
} from './actions';

// Events
export { RunEventEmitter } from './events/emitter';
export type { ExecutionEvent as ExecutionEventType } from './events/types';

// DAG
export { validateDAG, DAGValidationError } from './dag/validator';
export { DAGExecutor, StepFailedError } from './dag/executor';
export type { StepDefinition, InputMapping, DAGDefinition, EngineRunRequest } from './dag/types';

// Engine
export { ExecutionEngine } from './engine';
