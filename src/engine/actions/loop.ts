/**
 * loop action — array iteration (V1: extract + passthrough).
 *
 * V1 extracts the array from wiredInputs and passes it through.
 * Does NOT run downstream steps per-item (requires sub-DAG support).
 * Downstream steps receive the full array.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { extractByPath } from '../utils';

interface LoopParams {
  items_field: string;
  variable_name?: string;
}

export const loopAction: ActionDefinition = {
  type: 'loop',
  name: 'Loop',
  description: 'Extracts an array from inputs for iteration.',

  inputSchema: {
    type: 'object',
    properties: {
      items_field: { type: 'string', description: 'Dot-path to the array field' },
      variable_name: { type: 'string', description: 'Variable name for each item' },
    },
    required: ['items_field'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      items: { type: 'array' },
      count: { type: 'number' },
      variable_name: { type: 'string' },
    },
    required: ['items', 'count'],
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as LoopParams;
    const { items_field, variable_name = 'item' } = params;

    if (!items_field) {
      throw new Error('Loop requires an items_field to extract the array from');
    }

    const items = extractByPath(input.wiredInputs, items_field);

    if (!Array.isArray(items)) {
      throw new Error(
        `Field "${items_field}" is not an array (got ${typeof items}). ` +
        'Loop requires an array to iterate over.'
      );
    }

    return {
      data: {
        items,
        count: items.length,
        variable_name,
      },
      summary: `Loop: ${items.length} items (as "${variable_name}")`,
    };
  },
};
