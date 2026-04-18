import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Loader2, Sparkles } from 'lucide-react';
import clsx from 'clsx';
import type { ToolCall } from '../../types/chat';
import { useUIPreferences } from '../../context/UIPreferencesContext';
import ToolCallCard from './ToolCallCard';

interface ToolCallsGroupProps {
  toolCalls: ToolCall[];
  /** Assistant is still producing a reply (tools may be done, but text hasn't arrived). */
  isBusy?: boolean;
}

export default function ToolCallsGroup({ toolCalls, isBusy = false }: ToolCallsGroupProps) {
  const { t } = useTranslation();
  const { showToolCalls } = useUIPreferences();
  const [expanded, setExpanded] = useState(false);

  if (toolCalls.length === 0) return null;

  const toolsRunning = toolCalls.some((tc) => tc.status === 'running' || tc.status === 'pending');
  // Keep the "Working..." state alive through the gap between tools-done and text-arriving.
  const showBusy = toolsRunning || isBusy;
  const isOpen = showToolCalls || expanded;

  return (
    <div className="mb-2">
      {!showToolCalls && (
        <button
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className={clsx(
            'group inline-flex items-center gap-2 rounded-full border px-3 py-1.5',
            'text-[11px] font-medium cursor-pointer',
            'transition-all duration-200 ease-out',
            'animate-fade-in',
            showBusy
              ? 'border-accent/30 bg-accent/[0.06] text-accent hover:bg-accent/[0.1]'
              : 'border-border-subtle bg-bg-surface/60 text-text-secondary hover:text-text-primary hover:bg-bg-surface hover:border-border-default',
          )}
        >
          {showBusy ? (
            <Loader2 size={11} className="animate-spin flex-shrink-0" />
          ) : (
            <Sparkles
              size={11}
              className="flex-shrink-0 text-accent transition-transform duration-300 group-hover:scale-110"
            />
          )}
          <span className="tracking-tight">
            {showBusy
              ? t('toolCall.workingOnIt')
              : t('toolCall.actionsCount', { count: toolCalls.length })}
          </span>
          <ChevronDown
            size={11}
            className={clsx(
              'flex-shrink-0 transition-transform duration-250 ease-out',
              expanded ? 'rotate-180' : 'rotate-0',
              'opacity-70 group-hover:opacity-100',
            )}
          />
        </button>
      )}

      <div className={clsx('collapsible-grid', isOpen && 'is-open')}>
        <div className="collapsible-inner">
          <div className={clsx('flex flex-col gap-2', !showToolCalls && 'pt-2')}>
            {toolCalls.map((tc) => (
              <ToolCallCard key={tc.id} toolCall={tc} />
            ))}
            {/* In expanded mode, keep a live heartbeat so users see progress while the
                model composes its reply after the last tool call completes. */}
            {showToolCalls && showBusy && (
              <div className="flex items-center gap-2 text-xs text-text-tertiary py-1 animate-fade-in">
                <Loader2 size={12} className="animate-spin text-accent" />
                <span>
                  {t('toolCall.workingOnIt')}
                  <span className="thinking-dots" />
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
