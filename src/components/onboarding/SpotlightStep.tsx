/**
 * Spotlight overlay — dims the page everywhere except a set of target rects,
 * draws a pulsing cyan ring around each one, and renders a TooltipCard
 * adjacent to the primary target.
 *
 * Each step always reveals two things:
 *   1. The **primary** UI element (`step.target`) — what the copy is about.
 *   2. The **sidebar nav** for the active screen (`nav-{step.screen}`) — so
 *      the user always has a "you are here" anchor.
 *
 * Cutouts are produced by a single SVG `<mask>` (cleaner than 4 framing
 * panels and supports any number of regions). Every rect is clamped to the
 * viewport with a small inset so the cyan rings always form closed boxes
 * even when the underlying element extends offscreen (e.g. the Tasks board
 * filling the page below the fold).
 *
 * If the primary target can't be located in time we fall back to a centered
 * tooltip card so the tour never deadlocks.
 */

import { type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import TooltipCard from './TooltipCard';
import { useTargetRect, type TargetRect } from './useTargetRect';
import type { TourStep } from './tour-steps';

const RING_PADDING = 8;
const VIEWPORT_INSET = 6;
const TOOLTIP_GAP = 14;
const TOOLTIP_WIDTH = 360;
const TOOLTIP_EST_HEIGHT = 220;

interface SpotlightStepProps {
  step: TourStep;
  visibleIndex: number;
  visibleCount: number;
  onNext: () => void;
  onPrev: () => void;
  onSkip: () => void;
  isFirstSpotlight: boolean;
  isLastSpotlight: boolean;
}

export default function SpotlightStep({
  step,
  visibleIndex,
  visibleCount,
  onNext,
  onPrev,
  onSkip,
  isFirstSpotlight,
  isLastSpotlight,
}: SpotlightStepProps) {
  const { t } = useTranslation();

  const navTargetId = step.screen ? `nav-${step.screen}` : null;
  const primaryRect = useTargetRect(step.target);
  const navRect = useTargetRect(navTargetId);

  const title = t(step.titleKey);
  const body = t(step.bodyKey);

  // Fallback: primary target not found yet — soft full-screen dim + centered
  // card. Looks intentional and keeps the tour moving.
  if (!primaryRect) {
    return (
      <>
        <div
          className="fixed inset-0 z-[10000] bg-black/65 backdrop-blur-[2px]"
          aria-hidden
        />
        <TooltipCard
          emoji={step.emoji}
          title={title}
          body={body}
          visibleIndex={visibleIndex}
          visibleCount={visibleCount}
          onNext={onNext}
          onPrev={onPrev}
          onSkip={onSkip}
          isFirstSpotlight={isFirstSpotlight}
          isLastSpotlight={isLastSpotlight}
          style={{
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
          }}
        />
      </>
    );
  }

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Build the inflated, viewport-clamped ring boxes. Always two slots
  // (primary + optional nav) so the SVG mask + ring divs persist across step
  // changes and transition smoothly via CSS.
  const primaryRing = clampRing(primaryRect, vw, vh);
  const navRing = navRect ? clampRing(navRect, vw, vh) : null;

  // Tooltip placement: pick the side of the PRIMARY rect with the most space,
  // honoring the step's `side` hint when it fits.
  const space = {
    right: vw - (primaryRect.left + primaryRect.width) - TOOLTIP_GAP,
    left: primaryRect.left - TOOLTIP_GAP,
    bottom: vh - (primaryRect.top + primaryRect.height) - TOOLTIP_GAP,
    top: primaryRect.top - TOOLTIP_GAP,
  };

  const fits = {
    right: space.right >= TOOLTIP_WIDTH + 16,
    left: space.left >= TOOLTIP_WIDTH + 16,
    bottom: space.bottom >= TOOLTIP_EST_HEIGHT + 16,
    top: space.top >= TOOLTIP_EST_HEIGHT + 16,
  };

  let placement: 'top' | 'bottom' | 'left' | 'right' = 'right';
  const hint = step.side && step.side !== 'auto' ? step.side : null;
  if (hint && fits[hint]) {
    placement = hint;
  } else if (fits.right) placement = 'right';
  else if (fits.bottom) placement = 'bottom';
  else if (fits.top) placement = 'top';
  else if (fits.left) placement = 'left';
  else placement = 'bottom';

  const tooltipStyle: CSSProperties = (() => {
    switch (placement) {
      case 'right':
        return {
          left: Math.min(
            primaryRect.left + primaryRect.width + TOOLTIP_GAP,
            vw - TOOLTIP_WIDTH - 16,
          ),
          top: clamp(
            primaryRect.top + primaryRect.height / 2 - TOOLTIP_EST_HEIGHT / 2,
            16,
            vh - TOOLTIP_EST_HEIGHT - 16,
          ),
        };
      case 'left':
        return {
          left: Math.max(primaryRect.left - TOOLTIP_GAP - TOOLTIP_WIDTH, 16),
          top: clamp(
            primaryRect.top + primaryRect.height / 2 - TOOLTIP_EST_HEIGHT / 2,
            16,
            vh - TOOLTIP_EST_HEIGHT - 16,
          ),
        };
      case 'top':
        return {
          left: clamp(
            primaryRect.left + primaryRect.width / 2 - TOOLTIP_WIDTH / 2,
            16,
            vw - TOOLTIP_WIDTH - 16,
          ),
          top: Math.max(primaryRect.top - TOOLTIP_GAP - TOOLTIP_EST_HEIGHT, 16),
        };
      case 'bottom':
      default:
        return {
          left: clamp(
            primaryRect.left + primaryRect.width / 2 - TOOLTIP_WIDTH / 2,
            16,
            vw - TOOLTIP_WIDTH - 16,
          ),
          top: Math.min(
            primaryRect.top + primaryRect.height + TOOLTIP_GAP,
            vh - TOOLTIP_EST_HEIGHT - 16,
          ),
        };
    }
  })();

  return (
    <>
      {/* Dim layer with cutouts via SVG mask — the proven approach for
          steps 2–7. White inside the mask = dim renders, black =
          transparent (cutout). Two stable rect slots (primary + nav) so
          attribute changes between steps tween via CSS transition. */}
      <svg
        className="fixed inset-0 z-[10000] pointer-events-none"
        width={vw}
        height={vh}
        aria-hidden
      >
        <defs>
          <mask id="cerebro-tour-mask" maskUnits="userSpaceOnUse">
            <rect x={0} y={0} width={vw} height={vh} fill="white" />
            <rect
              key="primary"
              className="cerebro-tour-cutout"
              x={primaryRing.left}
              y={primaryRing.top}
              width={primaryRing.width}
              height={primaryRing.height}
              rx={8}
              ry={8}
              fill="black"
            />
            <rect
              key="nav"
              className="cerebro-tour-cutout"
              x={navRing?.left ?? 0}
              y={navRing?.top ?? 0}
              width={navRing?.width ?? 0}
              height={navRing?.height ?? 0}
              rx={8}
              ry={8}
              fill="black"
            />
          </mask>
        </defs>
        <rect
          x={0}
          y={0}
          width={vw}
          height={vh}
          fill="black"
          fillOpacity={0.65}
          mask="url(#cerebro-tour-mask)"
        />
      </svg>

      {/* Cyan ring on top of the dim around the primary cutout. The matching
          sidebar nav button gets its own glow via the `.tour-spotlit-nav`
          class applied directly in Sidebar — no overlay div needed for it. */}
      <div
        className="cerebro-tour-ring fixed z-[10001] rounded-lg pointer-events-none animate-spotlight-pulse"
        style={{
          left: primaryRing.left,
          top: primaryRing.top,
          width: primaryRing.width,
          height: primaryRing.height,
        }}
        aria-hidden
      />

      <TooltipCard
        emoji={step.emoji}
        title={title}
        body={body}
        visibleIndex={visibleIndex}
        visibleCount={visibleCount}
        onNext={onNext}
        onPrev={onPrev}
        onSkip={onSkip}
        side={placement}
        style={{ ...tooltipStyle, transition: 'top 320ms cubic-bezier(0.2, 0.7, 0.2, 1), left 320ms cubic-bezier(0.2, 0.7, 0.2, 1)' }}
        isFirstSpotlight={isFirstSpotlight}
        isLastSpotlight={isLastSpotlight}
      />
    </>
  );
}

interface RingBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Inflate a target rect by RING_PADDING (so the cyan ring breathes), then
 * clamp it inside the viewport with VIEWPORT_INSET on every side. Guarantees
 * the resulting box is fully visible — no half-drawn rings on overflow.
 */
function clampRing(r: TargetRect, vw: number, vh: number): RingBox {
  const left = Math.max(VIEWPORT_INSET, r.left - RING_PADDING);
  const top = Math.max(VIEWPORT_INSET, r.top - RING_PADDING);
  const right = Math.min(vw - VIEWPORT_INSET, r.left + r.width + RING_PADDING);
  const bottom = Math.min(vh - VIEWPORT_INSET, r.top + r.height + RING_PADDING);
  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
