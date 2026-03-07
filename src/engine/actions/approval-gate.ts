/**
 * approval_gate action — pass-through checkpoint that pauses execution
 * until the user grants approval.
 *
 * The actual pause/resume is handled by the executor's `onApprovalRequired`
 * callback (triggered because the step has `requiresApproval: true`).
 * This action simply forwards wiredInputs as output so downstream steps
 * receive upstream data unmodified.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';

export const approvalGateAction: ActionDefinition = {
  type: 'approval_gate',
  name: 'Approval Gate',
  description: 'Pauses execution and waits for user approval before continuing.',

  inputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Description shown in the approval request' },
    },
  },

  outputSchema: {
    type: 'object',
    properties: {
      data: { type: 'object' },
    },
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => ({
    data: { ...input.wiredInputs },
    summary: (input.params as { summary?: string }).summary || 'Approval granted — continuing.',
  }),
};
