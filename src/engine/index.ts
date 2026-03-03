/**
 * Execution Engine — barrel exports.
 *
 * Phase 1: Action infrastructure only.
 * Actions can be instantiated and executed individually outside the DAG.
 */

// Scratchpad
export { RunScratchpad } from './scratchpad';

// Actions
export {
  ActionRegistry,
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
