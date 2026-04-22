/**
 * http_request action — makes REST API calls.
 *
 * Supports GET/POST/PUT/PATCH/DELETE with common auth schemes.
 * URL, body, and header key/value pairs accept Mustache variables
 * from wiredInputs.
 */

import http from 'node:http';
import https from 'node:https';
import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { onAbort } from './utils/abort-helpers';
import { renderTemplate } from './utils/template';
import { isBlockedHost } from './utils/ssrf';

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10MB

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
    const vars = input.wiredInputs ?? {};

    const renderedUrl = renderTemplate(params.url ?? '', vars).trim();
    if (!renderedUrl) {
      throw new Error('HTTP request requires a URL');
    }

    const url = new URL(renderedUrl);

    if (isBlockedHost(url.hostname)) {
      throw new Error(`Requests to private/internal addresses are not allowed: ${url.hostname}`);
    }

    const renderedBody = params.body ? renderTemplate(params.body, vars) : '';

    const startTime = Date.now();

    // Build headers — only set Content-Type when there's a body
    const headers: Record<string, string> = {};
    if (renderedBody && params.method.toUpperCase() !== 'GET') {
      headers['Content-Type'] = 'application/json';
    }

    if (params.headers) {
      for (const h of params.headers) {
        const key = renderTemplate(h.key ?? '', vars).trim();
        const value = renderTemplate(h.value ?? '', vars);
        if (key && value) {
          headers[key] = value;
        }
      }
    }

    // Auth
    const authValue = params.auth_value
      ? renderTemplate(params.auth_value, vars)
      : '';
    if (params.auth_type === 'bearer' && authValue) {
      headers['Authorization'] = `Bearer ${authValue}`;
    } else if (params.auth_type === 'basic' && authValue) {
      if (!authValue.includes(':')) {
        throw new Error('Basic auth value must be in "username:password" format');
      }
      headers['Authorization'] = `Basic ${Buffer.from(authValue).toString('base64')}`;
    } else if (params.auth_type === 'api_key' && authValue) {
      const authHeader = renderTemplate(params.auth_header ?? '', vars).trim();
      headers[authHeader || 'X-API-Key'] = authValue;
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

            context.log(`${params.method.toUpperCase()} ${renderedUrl} -> ${res.statusCode} (${durationMs}ms)`);

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
      if (renderedBody && params.method.toUpperCase() !== 'GET') {
        req.write(renderedBody);
      }
      req.end();
    });
  },
};
