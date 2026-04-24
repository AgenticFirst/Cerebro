/**
 * Tiny main-process helpers for the `/settings/{key}` endpoint and
 * generic JSON HTTP round-trips to the local Python backend.
 *
 * Exists so that integration bridges (telegram, whatsapp, hubspot, …) don't
 * each keep a copy of the same http.request boilerplate. Distinct from
 * `src/engine/actions/utils/backend-fetch.ts` — that helper throws on 4xx
 * and targets engine actions; bridges want the raw `{ok, status, data}`
 * so they can treat 404 as "no value yet".
 */

import http from 'node:http';

export function backendGetSetting<T>(port: number, key: string): Promise<T | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/settings/${encodeURIComponent(key)}`, (res) => {
      if (res.statusCode !== 200) {
        resolve(null);
        res.resume();
        return;
      }
      let data = '';
      res.on('data', (c: Buffer) => { data += c.toString(); });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data) as { value: string };
          resolve(JSON.parse(parsed.value) as T);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5_000, () => { req.destroy(); resolve(null); });
  });
}

export async function backendPutSetting(port: number, key: string, value: unknown): Promise<void> {
  await backendJsonRequest(port, 'PUT', `/settings/${encodeURIComponent(key)}`, { value: JSON.stringify(value) });
}

export interface BackendJsonResponse<T> {
  ok: boolean;
  status: number;
  data: T | null;
}

export function backendJsonRequest<T = unknown>(
  port: number,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<BackendJsonResponse<T>> {
  return new Promise((resolve) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr).toString() } : {}),
        },
        timeout: 15_000,
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => {
          let parsed: T | null = null;
          try { parsed = JSON.parse(data) as T; } catch { parsed = null; }
          resolve({
            ok: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode ?? 0,
            data: parsed,
          });
        });
      },
    );
    req.on('error', () => resolve({ ok: false, status: 0, data: null }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, data: null }); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}
