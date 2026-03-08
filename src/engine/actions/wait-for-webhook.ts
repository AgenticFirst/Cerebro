/**
 * wait_for_webhook action — pauses execution until an external HTTP callback arrives.
 *
 * Registers a temporary listener on the backend, then polls for the received
 * payload. Cleans up on cancellation or timeout.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { backendFetch } from './utils/backend-fetch';
import { onAbort } from './utils/abort-helpers';

interface WaitForWebhookParams {
  match_path?: string;
  timeout?: number;
  description?: string;
}

interface ListenerResponse {
  listener_id: string;
  endpoint_url: string;
}

interface StatusResponse {
  received: boolean;
  payload?: Record<string, unknown>;
  headers?: Record<string, string>;
  received_at?: string;
}

const POLL_INTERVAL_MS = 2000;

export const waitForWebhookAction: ActionDefinition = {
  type: 'wait_for_webhook',
  name: 'Wait for Webhook',
  description: 'Pauses until an external HTTP callback arrives.',

  inputSchema: {
    type: 'object',
    properties: {
      match_path: { type: 'string' },
      timeout: { type: 'number' },
      description: { type: 'string' },
    },
  },

  outputSchema: {
    type: 'object',
    properties: {
      payload: { type: 'object' },
      headers: { type: 'object' },
      received_at: { type: 'string' },
      endpoint_url: { type: 'string' },
    },
    required: ['payload', 'endpoint_url'],
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as WaitForWebhookParams;
    const { context } = input;
    const timeoutSecs = params.timeout ?? 3600;

    // Register listener
    const listener = await backendFetch<ListenerResponse>(
      context.backendPort,
      'POST',
      '/webhooks/listen',
      {
        match_path: params.match_path ?? '',
        timeout: timeoutSecs,
        description: params.description ?? '',
      },
      context.signal,
    );

    context.log(`Webhook endpoint: ${listener.endpoint_url}`);
    context.log(`Waiting for webhook (timeout: ${timeoutSecs}s)...`);

    const deadline = Date.now() + timeoutSecs * 1000;
    let result: ActionOutput | undefined;

    try {
      // Poll for received webhook
      while (Date.now() < deadline) {
        if (context.signal.aborted) {
          throw new Error('Aborted');
        }

        const status = await backendFetch<StatusResponse>(
          context.backendPort,
          'GET',
          `/webhooks/catch/${listener.listener_id}/status`,
          null,
          context.signal,
        );

        if (status.received) {
          result = {
            data: {
              payload: status.payload ?? {},
              headers: status.headers ?? {},
              received_at: status.received_at ?? new Date().toISOString(),
              endpoint_url: listener.endpoint_url,
            },
            summary: `Webhook received at ${listener.endpoint_url}`,
          };
          return result;
        }

        // Wait before next poll (with abort cleanup)
        await new Promise<void>((resolve, reject) => {
          if (context.signal.aborted) {
            reject(new Error('Aborted'));
            return;
          }
          let removeListener: () => void;
          const timer = setTimeout(() => {
            removeListener();
            resolve();
          }, POLL_INTERVAL_MS);
          removeListener = onAbort(context.signal, () => {
            clearTimeout(timer);
            reject(new Error('Aborted'));
          });
        });
      }

      throw new Error(`Webhook timeout: no callback received within ${timeoutSecs}s`);
    } finally {
      // Always cleanup listener (success, error, or cancellation)
      backendFetch(
        context.backendPort,
        'DELETE',
        `/webhooks/listen/${listener.listener_id}`,
        null,
      ).catch(() => {}); // fire-and-forget cleanup
    }
  },
};
