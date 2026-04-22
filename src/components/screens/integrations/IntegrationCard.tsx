import { useState, type ComponentType, type ReactNode } from 'react';
import clsx from 'clsx';
import { ChevronDown, Sparkles } from 'lucide-react';

interface IntegrationCardProps {
  icon: ComponentType<{ size?: number; className?: string }>;
  iconBg: string;
  iconColor: string;
  name: string;
  description: string;
  /** Right-aligned status pill. Renders next to the chevron when present. */
  status?: ReactNode;
  /** Primary call-to-action always rendered in the header, regardless of
   *  expand state. Clicking the button does NOT toggle expand — useful for
   *  "Connect" or "Tour" flows that open a modal instead of revealing the
   *  inline form. */
  primaryAction?: { label: string; onClick: () => void };
  /** When true, the card has no expandable body and just shows the chrome. */
  comingSoon?: boolean;
  defaultExpanded?: boolean;
  /** Expanded body. Ignored when `comingSoon` is true. */
  children?: ReactNode;
}

export default function IntegrationCard({
  icon: Icon,
  iconBg,
  iconColor,
  name,
  description,
  status,
  primaryAction,
  comingSoon,
  defaultExpanded = false,
  children,
}: IntegrationCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const expandable = !comingSoon && !!children;

  return (
    <div
      className={clsx(
        'bg-bg-surface border border-border-subtle rounded-lg overflow-hidden',
        'transition-colors',
        expandable && 'hover:border-border-default',
      )}
    >
      <div
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : -1}
        aria-expanded={expandable ? expanded : undefined}
        onClick={() => expandable && setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (!expandable) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        className={clsx(
          'w-full flex items-center gap-3 px-4 py-3.5 text-left select-none',
          expandable && 'cursor-pointer',
          !expandable && 'cursor-default',
        )}
      >
        <div
          className={clsx(
            'w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0',
            iconBg,
            iconColor,
          )}
        >
          <Icon size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-text-primary">{name}</div>
          <div className="text-xs text-text-secondary mt-0.5 truncate">{description}</div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          {status}
          {primaryAction && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); primaryAction.onClick(); }}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-accent/15 text-accent hover:bg-accent/25 transition-colors flex items-center gap-1.5"
            >
              <Sparkles size={12} />
              {primaryAction.label}
            </button>
          )}
          {expandable && (
            <ChevronDown
              size={16}
              className={clsx(
                'text-text-tertiary transition-transform',
                expanded && 'rotate-180',
              )}
            />
          )}
        </div>
      </div>

      {expandable && expanded && (
        <div className="border-t border-border-subtle px-4 pt-4 pb-5">
          {children}
        </div>
      )}
    </div>
  );
}
