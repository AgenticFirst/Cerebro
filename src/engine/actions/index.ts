/**
 * Action system barrel exports.
 */

// Types
export type {
  ActionDefinition,
  ActionInput,
  ActionOutput,
  ActionContext,
  ExecutionEvent,
  JSONSchema,
  ResolvedModel,
} from './types';

// Registry
export { ActionRegistry } from './registry';

// Core / legacy actions
export { modelCallAction } from './model-call';
export { transformerAction } from './transformer';
export { createExpertStepAction } from './expert-step';
export type { ExpertStepContext } from './expert-step';
export { connectorAction } from './connector';
export type { ConnectorParams, ConnectorOutput } from './connector';
export { channelAction } from './channel';
export type { ChannelParams, ChannelOutput } from './channel';
export { approvalGateAction } from './approval-gate';

// Logic actions
export { conditionAction } from './condition';
export { delayAction } from './delay';
export { loopAction } from './loop';

// AI actions
export { classifyAction } from './classify';
export { extractAction } from './extract';
export { summarizeAction } from './summarize';

// Knowledge actions
export { searchMemoryAction } from './search-memory';
export { searchWebAction } from './search-web';
export { saveToMemoryAction } from './save-to-memory';

// Integration actions
export { httpRequestAction } from './http-request';
export { runCommandAction } from './run-command';
export { runClaudeCodeAction } from './run-claude-code';

// Output actions
export { sendMessageAction } from './send-message';
export { sendNotificationAction } from './send-notification';

// Complex actions
export { waitForWebhookAction } from './wait-for-webhook';
export { runScriptAction } from './run-script';

// Utilities
export { streamModelCall, resolveModelForAction, buildLLMRequestBody } from './utils/llm-call';
export { backendFetch } from './utils/backend-fetch';
