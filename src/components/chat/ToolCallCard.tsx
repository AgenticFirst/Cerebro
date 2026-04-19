import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Search, Brain, Zap, Globe, CheckCircle2, XCircle, Loader2, Users, FileText, Pencil, FilePlus, Terminal, FolderSearch, Code, Clock } from 'lucide-react';
import clsx from 'clsx';
import type { ToolCall } from '../../types/chat';

const TOOL_ICONS: Record<string, typeof Search> = {
  search_knowledge: Search,
  analyze_intent: Brain,
  web_search: Globe,
  delegate_to_expert: Users,
  // Claude Code tools
  Read: FileText,
  Edit: Pencil,
  Write: FilePlus,
  Bash: Terminal,
  Grep: Search,
  Glob: FolderSearch,
  WebSearch: Globe,
  WebFetch: Globe,
  LSP: Code,
  // Cerebro MCP tools
  cerebro_save_fact: Brain,
  cerebro_save_entry: FileText,
  cerebro_recall_facts: Brain,
  cerebro_recall_knowledge: Search,
  cerebro_web_search: Globe,
  cerebro_get_current_time: Clock,
  cerebro_list_experts: Users,
  cerebro_create_expert: Users,
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
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (toolCall.status !== 'running' || !toolCall.startedAt) return;
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - toolCall.startedAt!.getTime()) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [toolCall.status, toolCall.startedAt]);

  const Icon = TOOL_ICONS[toolCall.name] || Zap;
  const isDelegation = toolCall.name === 'delegate_to_expert';
  const expertName = toolCall.delegationExpertName;

  // Delegation-specific header text
  const headerText = isDelegation && expertName
    ? toolCall.status === 'running'
      ? `${expertName} is working...`
      : `${expertName} responded`
    : toolCall.description;

  // For delegation, strip the "[Response from {name}]" prefix from output
  const displayOutput = isDelegation && toolCall.output && expertName
    ? toolCall.output.replace(new RegExp(`^\\[Response from ${expertName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\s*`), '')
    : toolCall.output;

  // For delegation, show the task from arguments instead of raw args
  const delegationTask = isDelegation && toolCall.arguments?.task
    ? String(toolCall.arguments.task)
    : null;

  const subagentType =
    toolCall.name === 'Agent' && typeof toolCall.arguments?.subagent_type === 'string'
      ? (toolCall.arguments.subagent_type as string)
      : undefined;

  return (
    <div
      data-testid="tool-call-card"
      data-tool-name={toolCall.name}
      data-tool-status={toolCall.status}
      data-subagent-type={subagentType}
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
        <span className="flex-1 text-xs text-text-secondary truncate">{headerText}</span>
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
          {/* Delegation: Task section */}
          {delegationTask && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1">
                {t('toolCall.task')}
              </div>
              <div className="bg-bg-base rounded-md px-2.5 py-2 text-xs text-text-secondary">
                {delegationTask}
              </div>
            </div>
          )}

          {/* Arguments (hidden for delegation — shown as Task above) */}
          {!isDelegation && toolCall.arguments && Object.keys(toolCall.arguments).length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1">
                {t('toolCall.arguments')}
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

          {/* Output / Response */}
          {displayOutput && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1">
                {isDelegation ? t('toolCall.response') : t('toolCall.output')}
              </div>
              <div className="bg-bg-base rounded-md px-2.5 py-2 font-mono text-xs text-text-secondary whitespace-pre-wrap">
                {displayOutput}
              </div>
            </div>
          )}

          {/* Running indicator */}
          {toolCall.status === 'running' && !toolCall.output && (
            <div className="flex items-center gap-2 text-xs text-text-tertiary py-1">
              <Loader2 size={12} className="animate-spin" />
              {isDelegation && expertName
                ? t('toolCall.waitingFor', { name: expertName })
                : elapsed > 0 ? t('toolCall.runningElapsed', { seconds: elapsed }) : t('toolCall.running')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
