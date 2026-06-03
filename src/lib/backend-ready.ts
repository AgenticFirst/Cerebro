/**
 * Backend readiness gating for React contexts.
 *
 * On a cold app launch the renderer mounts before the Python backend's health
 * check passes. Until `backendStatus === 'healthy'`, `window.cerebro.invoke`
 * returns `{ ok: false, status: 0, ... }` without throwing — so any context that
 * fetches on mount silently loads nothing and never retries. Contexts that need
 * data at startup should `await waitForBackendHealthy()` before their first
 * fetch, mirroring the pattern in ProviderContext.
 */

/**
 * Poll backend status until it reports `'healthy'` (up to ~15s at 1s intervals).
 *
 * @param isCancelled - called between polls; return `true` to abort early
 *   (e.g. wired to an effect-cleanup flag so a fast unmount stops the loop).
 * @returns `true` once the backend is healthy, `false` if it never became
 *   healthy within the window or the caller cancelled.
 */
export async function waitForBackendHealthy(isCancelled: () => boolean): Promise<boolean> {
  for (let i = 0; i < 15; i++) {
    try {
      if ((await window.cerebro.getStatus()) === 'healthy') return true;
    } catch {
      /* not ready */
    }
    if (isCancelled()) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (isCancelled()) return false;
  try {
    return (await window.cerebro.getStatus()) === 'healthy';
  } catch {
    return false;
  }
}
