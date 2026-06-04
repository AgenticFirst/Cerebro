import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';

type Side = 'top' | 'bottom' | 'left' | 'right';
type Size = 'sm' | 'md';
type Variant = 'default' | 'accent';

interface TooltipProps {
  label: ReactNode;
  children: ReactElement;
  side?: Side;
  size?: Size;
  variant?: Variant;
  delay?: number;
  shortcut?: string;
  disabled?: boolean;
}

const GAP = 8;
const EDGE_PAD = 8;

export default function Tooltip({
  label,
  children,
  side = 'top',
  size = 'sm',
  variant = 'default',
  delay = 400,
  shortcut,
  disabled = false,
}: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; side: Side } | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const openTimer = useRef<number | null>(null);
  const childRefSlot = useRef<unknown>(null);

  const setTriggerRef = useCallback((node: HTMLElement | null) => {
    triggerRef.current = node;
    const r = childRefSlot.current;
    if (typeof r === 'function') (r as (n: HTMLElement | null) => void)(node);
    else if (r && typeof r === 'object' && 'current' in (r as object))
      (r as { current: HTMLElement | null }).current = node;
  }, []);

  const childHandlersRef = useRef<HTMLAttributes<HTMLElement>>({});

  const clearTimer = () => {
    if (openTimer.current) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  };

  const stateRef = useRef({ disabled, label, delay });
  stateRef.current = { disabled, label, delay };

  const show = useCallback((immediate = false) => {
    const { disabled: d, label: l, delay: dl } = stateRef.current;
    if (d || !l) return;
    clearTimer();
    if (immediate) {
      setOpen(true);
    } else {
      openTimer.current = window.setTimeout(() => setOpen(true), dl);
    }
  }, []);

  const hide = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, []);

  const onMouseEnter = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      childHandlersRef.current.onMouseEnter?.(e);
      show(false);
    },
    [show],
  );
  const onMouseLeave = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      childHandlersRef.current.onMouseLeave?.(e);
      hide();
    },
    [hide],
  );
  const onFocus = useCallback(
    (e: React.FocusEvent<HTMLElement>) => {
      childHandlersRef.current.onFocus?.(e);
      show(true);
    },
    [show],
  );
  const onBlur = useCallback(
    (e: React.FocusEvent<HTMLElement>) => {
      childHandlersRef.current.onBlur?.(e);
      hide();
    },
    [hide],
  );

  useEffect(() => () => clearTimer(), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    const onScroll = () => hide();
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, hide]);

  const position = useCallback(() => {
    const trig = triggerRef.current;
    const tip = tooltipRef.current;
    if (!trig || !tip) return;
    const t = trig.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const compute = (s: Side) => {
      let top = 0;
      let left = 0;
      if (s === 'top') {
        top = t.top - th - GAP;
        left = t.left + t.width / 2 - tw / 2;
      } else if (s === 'bottom') {
        top = t.bottom + GAP;
        left = t.left + t.width / 2 - tw / 2;
      } else if (s === 'left') {
        top = t.top + t.height / 2 - th / 2;
        left = t.left - tw - GAP;
      } else {
        top = t.top + t.height / 2 - th / 2;
        left = t.right + GAP;
      }
      return { top, left };
    };

    const fits = (s: Side, c: { top: number; left: number }) => {
      if (c.top < EDGE_PAD || c.top + th > vh - EDGE_PAD) return false;
      if (c.left < EDGE_PAD || c.left + tw > vw - EDGE_PAD) return false;
      return true;
    };

    const opposite: Record<Side, Side> = {
      top: 'bottom',
      bottom: 'top',
      left: 'right',
      right: 'left',
    };
    const order: Side[] = [side, opposite[side], 'top', 'bottom', 'left', 'right'];
    let chosen: Side = side;
    let c = compute(side);
    for (const s of order) {
      const candidate = compute(s);
      if (fits(s, candidate)) {
        chosen = s;
        c = candidate;
        break;
      }
    }

    const top = Math.max(EDGE_PAD, Math.min(c.top, vh - th - EDGE_PAD));
    const left = Math.max(EDGE_PAD, Math.min(c.left, vw - tw - EDGE_PAD));
    setCoords((prev) =>
      prev && prev.top === top && prev.left === left && prev.side === chosen
        ? prev
        : { top, left, side: chosen },
    );
  }, [side]);

  useLayoutEffect(() => {
    if (open) position();
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => position();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open, position]);

  const child = Children.only(children);
  if (!isValidElement(child)) return children;

  const childProps = (child.props ?? {}) as HTMLAttributes<HTMLElement> & { ref?: unknown };
  childRefSlot.current = childProps.ref;
  childHandlersRef.current = childProps;

  const mergedProps: HTMLAttributes<HTMLElement> & { 'aria-describedby'?: string; ref?: unknown } =
    {
      ...childProps,
      onMouseEnter,
      onMouseLeave,
      onFocus,
      onBlur,
      'aria-describedby': open ? id : childProps['aria-describedby'],
      ref: setTriggerRef,
    };

  const cloned = cloneElement(child, mergedProps);

  const tooltip = open
    ? createPortal(
        <div
          ref={tooltipRef}
          id={id}
          role="tooltip"
          style={{
            position: 'fixed',
            top: coords?.top ?? -9999,
            left: coords?.left ?? -9999,
            zIndex: 9999,
            opacity: coords ? 1 : 0,
          }}
          className={clsx(
            'pointer-events-none select-none',
            'rounded-md border shadow-lg',
            'bg-bg-elevated/95 backdrop-blur text-text-primary',
            'border-border-subtle',
            variant === 'accent' && 'border-l-2 border-l-accent',
            size === 'sm' && 'px-2.5 py-1.5 text-xs max-w-xs',
            size === 'md' && 'px-3 py-2.5 text-xs max-w-xs',
            coords && 'animate-fade-in',
          )}
        >
          <div className="flex items-start gap-2">
            <div className="flex-1 leading-relaxed">{label}</div>
            {shortcut && (
              <kbd className="shrink-0 rounded border border-border-subtle bg-bg-base px-1.5 py-0.5 text-[10px] font-mono text-text-tertiary">
                {shortcut}
              </kbd>
            )}
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      {cloned}
      {tooltip}
    </>
  );
}

export function TooltipCard({
  title,
  description,
  meta,
  hint,
}: {
  title?: ReactNode;
  description?: ReactNode;
  meta?: Array<{ label: ReactNode; value: ReactNode }>;
  hint?: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      {title && <div className="font-medium text-text-primary">{title}</div>}
      {description && <div className="text-text-secondary">{description}</div>}
      {meta && meta.length > 0 && (
        <div className="space-y-0.5 pt-0.5">
          {meta.map((m, i) => (
            <div key={i} className="flex gap-2 text-[11px]">
              <span className="text-text-tertiary">{m.label}</span>
              <span className="text-text-secondary truncate">{m.value}</span>
            </div>
          ))}
        </div>
      )}
      {hint && <div className="pt-0.5 text-[11px] text-text-tertiary italic">{hint}</div>}
    </div>
  );
}
