/**
 * Hook that tracks a DOM element's bounding rect, looked up by `data-tour-id`.
 * Re-measures on resize, scroll (window + scrollable ancestors), and on a
 * short rAF poll while the target is being mounted/laid-out (covers screen
 * transitions where the element appears a few frames after `setActiveScreen`).
 *
 * Returns `null` if the element can't be found within `timeoutMs` — callers
 * (SpotlightStep) fall back to a centered modal in that case so the tour
 * never deadlocks.
 */

import { useEffect, useState } from 'react';

export interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface Options {
  /** ms before we give up looking for the element. */
  timeoutMs?: number;
  /** ms between rect re-measures while we have a target. */
  pollMs?: number;
}

export function useTargetRect(
  targetId: string | null | undefined,
  { timeoutMs = 1200, pollMs = 200 }: Options = {},
): TargetRect | null {
  const [rect, setRect] = useState<TargetRect | null>(null);

  useEffect(() => {
    setRect(null);
    if (!targetId) return;

    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let giveUpTimer: ReturnType<typeof setTimeout> | null = null;

    const measure = () => {
      if (cancelled) return;
      const el = document.querySelector<HTMLElement>(
        `[data-tour-id="${targetId}"]`,
      );
      if (!el) return;
      const r = el.getBoundingClientRect();
      // Skip zero-sized rects (element is mounted but invisible / layout pending).
      if (r.width === 0 && r.height === 0) return;
      setRect((prev) => {
        if (
          prev &&
          prev.top === r.top &&
          prev.left === r.left &&
          prev.width === r.width &&
          prev.height === r.height
        ) {
          return prev;
        }
        return { top: r.top, left: r.left, width: r.width, height: r.height };
      });
    };

    // Initial attempt next frame so React commit completes first.
    const raf = requestAnimationFrame(measure);

    // Keep polling — cheap, robust to async screen transitions and sidebar
    // animations. Stops once we've measured AND the giveUp timer has fired.
    pollTimer = setInterval(measure, pollMs);
    giveUpTimer = setTimeout(() => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    }, timeoutMs);

    const onResize = () => measure();
    const onScroll = () => measure();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (pollTimer) clearInterval(pollTimer);
      if (giveUpTimer) clearTimeout(giveUpTimer);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [targetId, timeoutMs, pollMs]);

  return rect;
}
