/**
 * Spotlight overlay — dims the page everywhere except a target rect, draws
 * a pulsing cyan ring around the target, and renders a TooltipCard adjacent
 * to it. If the target can't be located in time we fall back to a centered
 * tooltip card so the tour never deadlocks.
 *
 * The dim panels are four absolutely positioned divs framing the target —
 * cheaper and more accessible than an SVG mask, and animates smoothly when
 * the rect changes during screen transitions.
 */

import { type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import TooltipCard from './TooltipCard';
import { useTargetRect } from './useTargetRect';
import type { TourStep } from './tour-steps';



const DIM = 'bg-black/65 backdrop-blur-[2px]';
const RING_PADDING = 8;
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
  const rect = useTargetRect(step.target);

  const title = t(step.titleKey);
  const body = t(step.bodyKey);

  // Fallback: target not found yet (or doesn't exist) — show a centered card
  // with a soft full-screen dim. Looks intentional, never deadlocks.
  if (!rect) {
    return (
      <>
        <div className={`fixed inset-0 z-[10000] ${DIM}`} aria-hidden />
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

  // Inflate the spotlight by RING_PADDING so the cyan ring breathes.
  const ringTop = rect.top - RING_PADDING;
  const ringLeft = rect.left - RING_PADDING;
  const ringWidth = rect.width + RING_PADDING * 2;
  const ringHeight = rect.height + RING_PADDING * 2;

  // Tooltip placement: pick the side with the most space, preferring the
  // step's `side` hint when it fits.
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const space = {
    right: vw - (rect.left + rect.width) - TOOLTIP_GAP,
    left: rect.left - TOOLTIP_GAP,
    bottom: vh - (rect.top + rect.height) - TOOLTIP_GAP,
    top: rect.top - TOOLTIP_GAP,
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

  // Compute tooltip position from placement.
  const tooltipStyle: CSSProperties = (() => {
    switch (placement) {
      case 'right':
        return {
          left: Math.min(
            rect.left + rect.width + TOOLTIP_GAP,
            vw - TOOLTIP_WIDTH - 16,
          ),
          top: clamp(
            rect.top + rect.height / 2 - TOOLTIP_EST_HEIGHT / 2,
            16,
            vh - TOOLTIP_EST_HEIGHT - 16,
          ),
        };
      case 'left':
        return {
          left: Math.max(rect.left - TOOLTIP_GAP - TOOLTIP_WIDTH, 16),
          top: clamp(
            rect.top + rect.height / 2 - TOOLTIP_EST_HEIGHT / 2,
            16,
            vh - TOOLTIP_EST_HEIGHT - 16,
          ),
        };
      case 'top':
        return {
          left: clamp(
            rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2,
            16,
            vw - TOOLTIP_WIDTH - 16,
          ),
          top: Math.max(rect.top - TOOLTIP_GAP - TOOLTIP_EST_HEIGHT, 16),
        };
      case 'bottom':
      default:
        return {
          left: clamp(
            rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2,
            16,
            vw - TOOLTIP_WIDTH - 16,
          ),
          top: Math.min(
            rect.top + rect.height + TOOLTIP_GAP,
            vh - TOOLTIP_EST_HEIGHT - 16,
          ),
        };
    }
  })();

  return (
    <>
      {/* Four dim panels framing the target. Each is fixed-positioned with
          inline geometry so they reflow smoothly when the rect changes. */}
      <div
        className={`fixed z-[10000] ${DIM}`}
        style={{ left: 0, top: 0, right: 0, height: ringTop }}
        aria-hidden
      />
      <div
        className={`fixed z-[10000] ${DIM}`}
        style={{
          left: 0,
          top: ringTop,
          width: ringLeft,
          height: ringHeight,
        }}
        aria-hidden
      />
      <div
        className={`fixed z-[10000] ${DIM}`}
        style={{
          left: ringLeft + ringWidth,
          top: ringTop,
          right: 0,
          height: ringHeight,
        }}
        aria-hidden
      />
      <div
        className={`fixed z-[10000] ${DIM}`}
        style={{
          left: 0,
          top: ringTop + ringHeight,
          right: 0,
          bottom: 0,
        }}
        aria-hidden
      />

      {/* Pulsing ring on the target. */}
      <div
        className="fixed z-[10000] rounded-lg pointer-events-none animate-spotlight-pulse"
        style={{
          left: ringLeft,
          top: ringTop,
          width: ringWidth,
          height: ringHeight,
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
        style={tooltipStyle}
        isFirstSpotlight={isFirstSpotlight}
        isLastSpotlight={isLastSpotlight}
      />
    </>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
