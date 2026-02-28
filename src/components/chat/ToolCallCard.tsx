import { useState } from 'react';
import { ChevronRight, Search, Brain, Zap, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import type { ToolCall } from '../../types/chat';

const TOOL_ICONS: Record<string, typeof Search> = {
  search_knowledge: Search,
  analyze_intent: Brain,
};

function StatusDot({ status }: { status: ToolCall['status'] }) {
  return (
    <span
      className={clsx(
        'absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full',
        status === 'running' && 'bg-yellow-500 animate-pulse',
        status === 'success' && 'bg-green-500',
        status === 'error' && 'bg-red-500',
        status === 'pending' && 'bg-zinc-400',
      )}
    />
  );
}

function StatusIcon({ status }: { status: ToolCall['status'] }) {
  if (status === 'running') return <Loader2 size={12} className="animate-spin text-yellow-500" />;
  if (status === 'success') return <CheckCircle2 size={12} className="text-green-500" />;
  if (status === 'error') return <XCircle size={12} className="text-red-500" />;
  return null;
}

interface ToolCallCardProps {
  toolCall: ToolCall;
}

export default function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const Icon = TOOL_ICONS[toolCall.name] || Zap;

  return (
    <div
      className={clsx(
        'animate-fade-in rounded-lg border overflow-hidden transition-colors duration-200',
        'border-border-default bg-bg-surface/50',
      )}
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className={clsx(
          'w-full flex items-center gap-2.5 px-3 py-2 text-left',
          'hover:bg-bg-hover/50 transition-colors duration-150 cursor-pointer',
        )}
      >
        <div className="relative flex-shrink-0">
          <Icon size={14} className="text-text-secondary" />
          <StatusDot status={toolCall.status} />
        </div>
        <span className="flex-1 text-xs text-text-secondary truncate">
          {toolCall.description}
        </span>
        <StatusIcon status={toolCall.status} />
        <ChevronRight
          size={12}
          className={clsx(
            'text-text-tertiary transition-transform duration-200 flex-shrink-0',
            expanded && 'rotate-90',
          )}
        />
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border-subtle px-3 py-2.5 space-y-2.5">
          {/* Arguments */}
          {toolCall.arguments && Object.keys(toolCall.arguments).length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1">
                Arguments
              </div>
              <div className="bg-bg-base rounded-md px-2.5 py-2 font-mono text-xs text-text-secondary">
                {Object.entries(toolCall.arguments).map(([key, val]) => (
                  <div key={key}>
                    <span className="text-accent">{key}</span>
                    <span className="text-text-tertiary">: </span>
                    <span>{typeof val === 'string' ? val : JSON.stringify(val)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Output */}
          {toolCall.output && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1">
                Output
              </div>
              <div className="bg-bg-base rounded-md px-2.5 py-2 font-mono text-xs text-text-secondary whitespace-pre-wrap">
                {toolCall.output}
              </div>
            </div>
          )}

          {/* Running indicator */}
          {toolCall.status === 'running' && !toolCall.output && (
            <div className="flex items-center gap-2 text-xs text-text-tertiary py-1">
              <Loader2 size={12} className="animate-spin" />
              Running...
            </div>
          )}
        </div>
      )}
    </div>
  );
}
