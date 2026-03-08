/**
 * Shared SSE streaming helper for LLM calls.
 *
 * Extracted from model-call.ts so that classify, extract, and summarize
 * actions can reuse the same streaming logic.
 */

import http from 'node:http';
import type { ActionContext, ResolvedModel } from '../types';
import { onAbort } from './abort-helpers';

// ── Types ────────────────────────────────────────────────────────

export interface BackendStreamEvent {
  token?: string | null;
  done?: boolean;
  finish_reason?: string | null;
  usage?: Record<string, unknown> | null;
}

// ── SSE streaming helper ─────────────────────────────────────────

export function streamModelCall(
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
            removeAbortListener();
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
              removeAbortListener();
              if (event.finish_reason === 'error') {
                const errorMsg = (event.usage as Record<string, unknown>)?.error || 'Model call failed';
                reject(new Error(String(errorMsg)));
                return;
              }
              resolve(accumulated);
              return;
            }
          }
        });

        res.on('end', () => {
          removeAbortListener();
          // Stream ended — may be partial if done was never received
          resolve(accumulated);
        });

        res.on('error', (err) => {
          removeAbortListener();
          reject(new Error(`Stream error: ${err.message}`));
        });
      },
    );

    req.on('error', (err) => {
      removeAbortListener();
      reject(new Error(`Request error: ${err.message}`));
    });

    // Handle abort
    const removeAbortListener = onAbort(signal, () => {
      req.destroy();
      reject(new Error('Aborted'));
    });

    req.write(bodyStr);
    req.end();
  });
}

// ── Model resolution + request body builder ──────────────────────

/**
 * Resolve which model to use: params override or global default.
 */
export async function resolveModelForAction(
  paramsModel: { source: 'local' | 'cloud'; provider?: string; modelId: string } | undefined,
  context: ActionContext,
): Promise<ResolvedModel> {
  if (paramsModel) {
    return {
      source: paramsModel.source,
      provider: paramsModel.provider,
      modelId: paramsModel.modelId,
      displayName: paramsModel.modelId,
    };
  }

  const model = await context.resolveModel();
  if (!model) {
    throw new Error('No model available. Configure a model in Integrations.');
  }
  return model;
}

/**
 * Build the request body and determine the endpoint path for an LLM call.
 */
export function buildLLMRequestBody(
  messages: Array<Record<string, unknown>>,
  model: ResolvedModel,
  options?: { temperature?: number; maxTokens?: number },
): { path: string; body: Record<string, unknown> } {
  const isLocal = model.source === 'local';
  const path = isLocal ? '/models/chat' : '/cloud/chat';

  const body: Record<string, unknown> = {
    messages,
    stream: true,
    max_tokens: options?.maxTokens ?? 4096,
    temperature: options?.temperature ?? 0.7,
  };

  if (!isLocal) {
    body.provider = model.provider;
    body.model = model.modelId;
  }

  return { path, body };
}
