/**
 * connector action — interface for external service integrations.
 *
 * V0 stub: Returns an error indicating the connector is not yet available.
 * Implementation deferred to roadmap Section 9.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';

// ── Types ───────────────────────────────────────────────────────

export interface ConnectorParams {
  service: string;
  operation: string;
  payload: Record<string, unknown>;
}

export interface ConnectorOutput {
  data: unknown;
  statusCode: number;
}

// ── Action definition ───────────────────────────────────────────

export const connectorAction: ActionDefinition = {
  type: 'connector',
  name: 'Connector',
  description: 'Reads from and writes to external services (Google Calendar, Gmail, Notion, etc.).',

  inputSchema: {
    type: 'object',
    properties: {
      service: { type: 'string', description: 'Service identifier (e.g. "google_calendar")' },
      operation: { type: 'string', description: 'Operation to perform (e.g. "list_events")' },
      payload: { type: 'object', description: 'Operation-specific parameters' },
    },
    required: ['service', 'operation'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      data: { description: 'Service response' },
      statusCode: { type: 'number' },
    },
    required: ['data', 'statusCode'],
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as ConnectorParams;
    throw new Error(`Connector '${params.service}' is not yet available. Connector support is coming in a future update.`);
  },
};
