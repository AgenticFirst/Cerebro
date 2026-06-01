/**
 * Renderer-side host-platform helpers.
 *
 * `window.cerebro.platform` is exposed synchronously by the preload bridge, so
 * these constants are safe to read at module load (including pre-paint).
 */

const platform = typeof window !== 'undefined' ? window.cerebro?.platform : undefined;

/** macOS — the only platform that uses the frameless `hiddenInset` title bar. */
export const IS_MAC = platform === 'darwin';
