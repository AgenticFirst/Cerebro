/**
 * model_call action — makes a single LLM call via backend SSE endpoints.
 *
 * One-shot, stateless. No multi-turn agent loop, no tool access.
 * Useful for summarization, formatting, analysis, and other
 * deterministic LLM tasks within a routine.
 */

import http from 'node:http';
import type { ActionDefinition, ActionInput, ActionOutput } from './types';

// ── Params / Output interfaces ──────────────────────────────────

interface ModelCallParams {
  prompt: string;
  systemPrompt?: string;
  model?: { source: 'local' | 'cloud'; provider?: string; modelId: string };
  temperature?: number;
  maxTokens?: number;
}

interface BackendStreamEvent {
  token?: string | null;
  done?: boolean;
  finish_reason?: string | null;
  usage?: Record<string, unknown> | null;
}

// ── Action definition ───────────────────────────────────────────

export const modelCallAction: ActionDefinition = {
  type: 'model_call',
  name: 'Model Call',
  description: 'Makes a single LLM call via the backend streaming endpoints.',

  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The user message / instruction' },
      systemPrompt: { type: 'string', description: 'Optional system prompt' },
      temperature: { type: 'number', description: 'Sampling temperature (default 0.7)' },
      maxTokens: { type: 'number', description: 'Max tokens (default 4096)' },
    },
    required: ['prompt'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      response: { type: 'string' },
      tokenCount: { type: 'number' },
    },
    required: ['response'],
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as ModelCallParams;
    const { context } = input;

    // Resolve model — override from params or global
    const model = params.model
      ? { source: params.model.source, provider: params.model.provider, modelId: params.model.modelId, displayName: params.model.modelId }
      : await context.resolveModel();

    if (!model) {
      throw new Error('No model available. Configure a model in Integrations.');
    }

    // Build messages
    const messages: Array<Record<string, unknown>> = [];
    if (params.systemPrompt) {
      messages.push({ role: 'system', content: params.systemPrompt });
    }
    messages.push({ role: 'user', content: params.prompt });

    // Determine endpoint
    const isLocal = model.source === 'local';
    const path = isLocal ? '/models/chat' : '/cloud/chat';

    const body: Record<string, unknown> = {
      messages,
      stream: true,
      max_tokens: params.maxTokens ?? 4096,
      temperature: params.temperature ?? 0.7,
    };

    if (!isLocal) {
      body.provider = model.provider;
      body.model = model.modelId;
    }

    // Stream from backend, collect response
    const response = await streamModelCall(
      context.backendPort,
      path,
      body,
      context.signal,
      (chunk: string) => context.log(chunk),
    );

    const summary = response.length > 80
      ? response.slice(0, 77) + '...'
      : response;

    return {
      data: { response },
      summary: `Model responded: ${summary}`,
    };
  },
};

// ── SSE streaming helper ────────────────────────────────────────

function streamModelCall(
  port: number,
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  onChunk: (chunk: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    const bodyStr = JSON.stringify(body);

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr).toString(),
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let errorBody = '';
          res.on('data', (chunk: Buffer) => { errorBody += chunk.toString(); });
          res.on('end', () => {
            let msg = `Backend error (${res.statusCode})`;
            try {
              const parsed = JSON.parse(errorBody);
              if (parsed.detail) msg = parsed.detail;
            } catch { /* use default */ }
            reject(new Error(msg));
          });
          return;
        }

        let buffer = '';
        let accumulated = '';

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;

            let event: BackendStreamEvent;
            try {
              event = JSON.parse(trimmed.slice(6));
            } catch {
              continue;
            }

            if (event.token) {
              accumulated += event.token;
              onChunk(event.token);
            }

            if (event.done) {
              if (event.finish_reason === 'error') {
                const errorMsg = (event.usage as any)?.error || 'Model call failed';
                reject(new Error(errorMsg));
                return;
              }
              resolve(accumulated);
              return;
            }
          }
        });

        res.on('end', () => {
          resolve(accumulated);
        });

        res.on('error', (err) => {
          reject(new Error(`Stream error: ${err.message}`));
        });
      },
    );

    req.on('error', (err) => {
      reject(new Error(`Request error: ${err.message}`));
    });

    // Handle abort
    const onAbort = () => {
      req.destroy();
      reject(new Error('Aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    req.write(bodyStr);
    req.end();
  });
}
