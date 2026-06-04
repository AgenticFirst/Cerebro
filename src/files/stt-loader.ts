/**
 * On-demand loader for the Whisper speech-to-text model, shared by every
 * integration bridge that transcribes voice notes (Telegram, Slack, WhatsApp).
 *
 * The first voice note in a session may need to load — or download (~150MB) —
 * the model, which is slow. A burst of concurrent voice notes is coalesced onto
 * a single load attempt so it happens once, with a single "loading…" notice.
 * Each bridge keeps one `SttLoader` instance (the in-flight state is per-bridge)
 * and supplies the backend port plus a callback that posts the notice the way
 * its own chat surface does.
 *
 * Self-contained on `backendJsonRequest` + node http, so the bridges no longer
 * each carry a copy of this lifecycle.
 */

import http from 'node:http';

import { backendJsonRequest } from '../shared/backend-settings';

/** The Whisper model the bridges auto-load for voice-note transcription. */
export const STT_MODEL_ID = 'faster-whisper-base';

/** The "first voice note is slow" notice every bridge posts before a load. */
export const STT_LOADING_NOTICE =
  '🎙️ First voice note in this session — loading the transcription model. ' +
  'Future voice notes will be instant. (~30–60s if downloading for the first time.)';

export class SttLoader {
  private inFlight: Promise<boolean> | null = null;

  constructor(private readonly port: () => number) {}

  /**
   * Ensure the model is loaded and `/voice/stt/transcribe-file` is safe to call.
   * `notifyLoading` is awaited once — only when an actual (slow) load starts,
   * not on the already-loaded fast path — and its failures are non-fatal.
   */
  async ensureReady(notifyLoading: () => Promise<void>): Promise<boolean> {
    const port = this.port();

    // Fast path: already loaded.
    const status = await backendJsonRequest<{ stt: { is_loaded: boolean } }>(
      port,
      'GET',
      '/voice/status',
    );
    if (status.ok && status.data?.stt?.is_loaded) return true;

    // Coalesce a burst of voice notes onto one load attempt.
    if (this.inFlight) return this.inFlight;

    const load = (async (): Promise<boolean> => {
      try {
        await notifyLoading();
      } catch {
        /* non-fatal */
      }

      // 404 means the model isn't on disk → auto-download, then load.
      let loadRes = await backendJsonRequest(port, 'POST', '/voice/stt/load');
      if (loadRes.status === 404) {
        if (!(await downloadSttModel(port))) return false;
        loadRes = await backendJsonRequest(port, 'POST', '/voice/stt/load');
      }
      return loadRes.ok;
    })();

    this.inFlight = load.finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Abandon any in-flight load — call on bridge shutdown/disconnect. */
  reset(): void {
    this.inFlight = null;
  }
}

/**
 * Trigger and wait for the Whisper STT model download via the existing
 * /voice/download SSE stream. Resolves true once the catalog reports the model
 * installed, false on any error or unexpected terminal state.
 */
function downloadSttModel(port: number): Promise<boolean> {
  return backendJsonRequest<{ state: { status: string } }>(port, 'POST', '/voice/download/start', {
    model_id: STT_MODEL_ID,
  }).then((start) => {
    // 409 = already in progress — fine, we'll just attach to the stream.
    if (!start.ok && start.status !== 409) return false;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        req.destroy();
        resolve(ok);
      };
      const req = http.get(
        `http://127.0.0.1:${port}/voice/download/stream/${STT_MODEL_ID}`,
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            finish(false);
            return;
          }
          let buf = '';
          res.on('data', (c: Buffer) => {
            buf += c.toString();
            // SSE frames are `data: <json>\n\n`. Process complete frames.
            let idx;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
              const frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const line = frame.split('\n').find((l) => l.startsWith('data: '));
              if (!line) continue;
              try {
                const evt = JSON.parse(line.slice(6)) as { state?: string; status?: string };
                const state = evt.state || evt.status;
                if (state === 'installed' || state === 'completed' || state === 'done') {
                  finish(true);
                  return;
                }
                if (state === 'failed' || state === 'cancelled' || state === 'error') {
                  finish(false);
                  return;
                }
              } catch {
                /* ignore malformed frame */
              }
            }
          });
          res.on('end', () => finish(false));
          res.on('error', () => finish(false));
        },
      );
      req.on('error', () => finish(false));
      // Allow plenty of time — the model is ~150MB.
      req.setTimeout(5 * 60 * 1000, () => finish(false));
    });
  });
}
