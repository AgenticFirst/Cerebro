/**
 * Shared abort-listener cleanup utility.
 *
 * Returns a cleanup function that removes the listener on the happy path,
 * preventing listener leaks on long-lived AbortSignals.
 */

export function onAbort(signal: AbortSignal, handler: () => void): () => void {
  signal.addEventListener('abort', handler, { once: true });
  return () => signal.removeEventListener('abort', handler);
}
