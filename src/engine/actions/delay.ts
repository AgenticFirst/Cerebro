/**
 * delay action — timed pause before continuing.
 *
 * Supports seconds, minutes, and hours. Respects cancellation
 * via the context's AbortSignal.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { onAbort } from './utils/abort-helpers';

interface DelayParams {
  duration: number;
  unit: 'seconds' | 'minutes' | 'hours';
}

function toMs(duration: number, unit: string): number {
  switch (unit) {
    case 'minutes': return duration * 60_000;
    case 'hours': return duration * 3_600_000;
    default: return duration * 1_000;
  }
}

export const delayAction: ActionDefinition = {
  type: 'delay',
  name: 'Delay',
  description: 'Pauses execution for a specified duration.',

  inputSchema: {
    type: 'object',
    properties: {
      duration: { type: 'number', description: 'How long to wait' },
      unit: { type: 'string', enum: ['seconds', 'minutes', 'hours'] },
    },
    required: ['duration', 'unit'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      delayed_ms: { type: 'number' },
      completed_at: { type: 'string' },
    },
    required: ['delayed_ms', 'completed_at'],
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as DelayParams;
    const { context } = input;

    if (!params.duration || params.duration <= 0) {
      throw new Error('Delay requires a positive duration');
    }

    const ms = toMs(params.duration, params.unit);

    context.log(`Waiting ${params.duration} ${params.unit}...`);

    await new Promise<void>((resolve, reject) => {
      if (context.signal.aborted) {
        reject(new Error('Aborted'));
        return;
      }

      const timer = setTimeout(() => {
        removeAbortListener();
        resolve();
      }, ms);

      const removeAbortListener = onAbort(context.signal, () => {
        clearTimeout(timer);
        reject(new Error('Aborted'));
      });
    });

    return {
      data: {
        delayed_ms: ms,
        completed_at: new Date().toISOString(),
        ...input.wiredInputs,
      },
      summary: `Delayed ${params.duration} ${params.unit}`,
    };
  },
};
