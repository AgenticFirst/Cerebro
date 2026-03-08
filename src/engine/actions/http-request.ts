/**
 * http_request action — makes REST API calls.
 *
 * Replaces the V0 connector.ts stub. Supports GET/POST/PUT/PATCH/DELETE
 * with various authentication schemes.
 */

import http from 'node:http';
import https from 'node:https';
import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { onAbort } from './utils/abort-helpers';

interface HttpRequestParams {
  method: string;
  url: string;
  headers?: Array<{ key: string; value: string }>;
  body?: string;
  auth_type?: 'none' | 'bearer' | 'basic' | 'api_key';
  auth_value?: string;
  auth_header?: string;
  timeout?: number;
}

// ── SSRF protection ──────────────────────────────────────────────

const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal']);

function isPrivateIP(hostname: string): boolean {
  // IPv4 checks
  const parts = hostname.split('.').map(Number);
  if (parts.length === 4 && parts.every(p => !isNaN(p))) {
    if (parts[0] === 127) return true;                           // 127.0.0.0/8
    if (parts[0] === 10) return true;                            // 10.0.0.0/8
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;  // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true;      // 192.168.0.0/16
    if (parts[0] === 169 && parts[1] === 254) return true;      // 169.254.0.0/16 (link-local/cloud metadata)
    if (parts[0] === 0) return true;                             // 0.0.0.0/8
  }
  // IPv6 checks
  if (hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd')) return true;
  return false;
}

// ── Body size limit ──────────────────────────────────────────────

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10MB

export const httpRequestAction: ActionDefinition = {
  type: 'http_request',
  name: 'HTTP Request',
  description: 'Makes a REST API call to any URL.',

  inputSchema: {
    type: 'object',
    properties: {
      method: { type: 'string' },
      url: { type: 'string' },
      headers: { type: 'array' },
      body: { type: 'string' },
      auth_type: { type: 'string' },
      timeout: { type: 'number' },
    },
    required: ['method', 'url'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'number' },
      body: {},
      headers: { type: 'object' },
      duration_ms: { type: 'number' },
    },
    required: ['status', 'body'],
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as HttpRequestParams;
    const { context } = input;

    if (!params.url) {
      throw new Error('HTTP request requires a URL');
    }

    const url = new URL(params.url);

    // SSRF protection: block private/internal addresses
    if (BLOCKED_HOSTS.has(url.hostname) || isPrivateIP(url.hostname)) {
      throw new Error(`Requests to private/internal addresses are not allowed: ${url.hostname}`);
    }

    const startTime = Date.now();

    // Build headers — only set Content-Type when there's a body
    const headers: Record<string, string> = {};
    if (params.body && params.method.toUpperCase() !== 'GET') {
      headers['Content-Type'] = 'application/json';
    }

    // Custom headers
    if (params.headers) {
      for (const h of params.headers) {
        if (h.key && h.value) {
          headers[h.key] = h.value;
        }
      }
    }

    // Auth
    if (params.auth_type === 'bearer' && params.auth_value) {
      headers['Authorization'] = `Bearer ${params.auth_value}`;
    } else if (params.auth_type === 'basic' && params.auth_value) {
      if (!params.auth_value.includes(':')) {
        throw new Error('Basic auth value must be in "username:password" format');
      }
      headers['Authorization'] = `Basic ${Buffer.from(params.auth_value).toString('base64')}`;
    } else if (params.auth_type === 'api_key' && params.auth_value) {
      headers[params.auth_header || 'X-API-Key'] = params.auth_value;
    }

    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const timeoutMs = (params.timeout ?? 30) * 1000;

    return new Promise((resolve, reject) => {
      if (context.signal.aborted) {
        reject(new Error('Aborted'));
        return;
      }

      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: params.method.toUpperCase(),
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          let data = '';
          let byteCount = 0;

          res.on('data', (chunk: Buffer) => {
            byteCount += chunk.length;
            if (byteCount > MAX_RESPONSE_BYTES) {
              res.destroy();
              reject(new Error(`Response body exceeds ${MAX_RESPONSE_BYTES / 1024 / 1024}MB limit`));
              return;
            }
            data += chunk.toString();
          });

          res.on('end', () => {
            removeAbortListener();
            const durationMs = Date.now() - startTime;
            const contentType = res.headers['content-type'] ?? '';

            // Parse JSON body if applicable
            let responseBody: unknown;
            if (contentType.includes('application/json')) {
              try {
                responseBody = JSON.parse(data);
              } catch {
                responseBody = data;
              }
            } else {
              responseBody = data;
            }

            context.log(`${params.method.toUpperCase()} ${params.url} -> ${res.statusCode} (${durationMs}ms)`);

            resolve({
              data: {
                status: res.statusCode,
                body: responseBody,
                headers: res.headers,
                duration_ms: durationMs,
              },
              summary: `${params.method.toUpperCase()} ${url.pathname} -> ${res.statusCode}`,
            });
          });
        },
      );

      req.on('error', (err) => {
        removeAbortListener();
        reject(new Error(`HTTP request failed: ${err.message}`));
      });

      req.on('timeout', () => {
        removeAbortListener();
        req.destroy();
        reject(new Error(`HTTP request timed out after ${timeoutMs}ms`));
      });

      const removeAbortListener = onAbort(context.signal, () => {
        req.destroy();
        reject(new Error('Aborted'));
      });

      // Send body for non-GET requests
      if (params.body && params.method.toUpperCase() !== 'GET') {
        req.write(params.body);
      }
      req.end();
    });
  },
};
