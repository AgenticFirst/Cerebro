/**
 * save_to_memory action — persists a memory item to the backend.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { backendFetch } from './utils/backend-fetch';

interface SaveToMemoryParams {
  content: string;
  scope?: string;
  type?: 'fact' | 'knowledge_entry';
}

export const saveToMemoryAction: ActionDefinition = {
  type: 'save_to_memory',
  name: 'Save to Memory',
  description: 'Persists a fact or knowledge entry to the memory system.',

  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string' },
      scope: { type: 'string' },
      type: { type: 'string', enum: ['fact', 'knowledge_entry'] },
    },
    required: ['content'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      saved: { type: 'boolean' },
      item_id: { type: 'string' },
    },
    required: ['saved'],
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as SaveToMemoryParams;
    const { context } = input;

    if (!params.content) {
      throw new Error('Save to memory requires content');
    }

    // Use the existing memory items endpoint
    const response = await backendFetch<{ id: string }>(
      context.backendPort,
      'POST',
      '/memory/items',
      {
        content: params.content,
        scope: params.scope ?? 'personal',
        ...(params.type ? { type: params.type } : {}),
      },
      context.signal,
    );

    const preview = params.content.length > 50 ? params.content.slice(0, 50) + '...' : params.content;
    context.log(`Saved memory item: ${preview}`);

    const summaryPreview = params.content.length > 40 ? params.content.slice(0, 40) + '...' : params.content;
    return {
      data: {
        saved: true,
        item_id: response.id,
      },
      summary: `Saved to memory: ${summaryPreview}`,
    };
  },
};
