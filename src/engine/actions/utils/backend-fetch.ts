/**
 * Shared HTTP helper for non-streaming requests to the backend.
 *
 * Used by search-memory, search-web, save-to-memory, send-message,
 * and other actions that need to call backend endpoints.
 */

import http from 'node:http';
import { onAbort } from './abort-helpers';

export function backendFetch<T = unknown>(
  port: number,
  method: string,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    const bodyStr = body != null ? JSON.stringify(body) : '';

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr).toString() } : {}),
        },
        timeout: 30_000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          removeAbortListener?.();
          if (res.statusCode && res.statusCode >= 400) {
            let msg = `Backend error (${res.statusCode})`;
            try {
              const parsed = JSON.parse(data);
              if (parsed.detail) msg = parsed.detail;
            } catch { /* use default */ }
            const err = new Error(msg) as Error & { status?: number };
            err.status = res.statusCode;
            reject(err);
            return;
          }
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            // Non-JSON response — wrap so callers get a predictable shape
            resolve({ raw: data } as unknown as T);
          }
        });
      },
    );

    req.on('error', (err) => {
      removeAbortListener?.();
      reject(new Error(`Request error: ${err.message}`));
    });

    req.on('timeout', () => {
      removeAbortListener?.();
      req.destroy();
      reject(new Error('Request timed out'));
    });

    // Handle abort
    let removeAbortListener: (() => void) | undefined;
    if (signal) {
      removeAbortListener = onAbort(signal, () => {
        req.destroy();
        reject(new Error('Aborted'));
      });
    }

    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}
