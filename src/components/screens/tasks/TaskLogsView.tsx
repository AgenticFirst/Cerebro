import { useRef, useEffect, useState, useCallback } from 'react';
import { ArrowDown, Wrench, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import type { Task, TaskLogEntry } from './types';

interface TaskLogsViewProps {
  task: Task;
  liveTask: {
    taskId: string;
    logEntries: TaskLogEntry[];
  } | null;
}

export default function TaskLogsView({ task, liveTask }: TaskLogsViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const [historicalLogs, setHistoricalLogs] = useState<TaskLogEntry[]>([]);

  // Use live logs if available, otherwise fetch historical
  const entries = liveTask?.taskId === task.id
    ? liveTask.logEntries
    : historicalLogs;

  // Fetch historical events for completed tasks
  useEffect(() => {
    if (liveTask?.taskId === task.id) return;
    let cancelled = false;
    window.cerebro.invoke<Array<{ kind: string; payload_json: string }>>({
      method: 'GET',
      path: `/tasks/${task.id}/events?limit=5000`,
    }).then((res) => {
      if (cancelled || !res.ok || !Array.isArray(res.data)) return;
      const logs: TaskLogEntry[] = [];
      for (const evt of res.data) {
        try {
          const payload = JSON.parse(evt.payload_json);
          if (evt.kind === 'text_delta') {
            logs.push({ kind: 'text_delta', text: payload.delta ?? '', phaseId: payload.phaseId ?? null });
          } else if (evt.kind === 'tool_start') {
            logs.push({ kind: 'tool_start', toolCallId: payload.toolCallId, toolName: payload.toolName, args: payload.args });
          } else if (evt.kind === 'tool_end') {
            logs.push({ kind: 'tool_end', toolCallId: payload.toolCallId, toolName: payload.toolName, result: payload.result, isError: payload.isError });
          } else if (evt.kind === 'error') {
            logs.push({ kind: 'error', message: payload.error ?? 'Unknown error' });
          } else if (evt.kind === 'system') {
            logs.push({ kind: 'system', message: payload.message ?? 'system event' });
          }
        } catch {
          // skip malformed
        }
      }
      setHistoricalLogs(logs);
    });
    return () => { cancelled = true; };
  }, [task.id, liveTask?.taskId]);

  // Pin to bottom unless user scrolled up
  useEffect(() => {
    if (!userScrolledUp) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }
  });

  // Detect user scrolling up via wheel — the only reliable signal for intent
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.deltaY < 0) {
      // User scrolled up
      setUserScrolledUp(true);
    } else if (e.deltaY > 0 && scrollRef.current) {
      // User scrolled down — re-enable if near bottom
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      if (scrollHeight - scrollTop - clientHeight < 80) {
        setUserScrolledUp(false);
      }
    }
  }, []);

  if (entries.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm py-16">
        {task.status === 'running' || task.status === 'clarifying'
          ? 'Waiting for output...'
          : 'No logs available'}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      <div
        ref={scrollRef}
        onWheel={handleWheel}
        className="flex-1 overflow-y-auto scrollbar-thin px-4 py-3 font-mono text-xs bg-zinc-950/50"
      >
        {entries.map((entry, i) => (
          <LogEntry key={i} entry={entry} />
        ))}
        <div ref={bottomRef} />
      </div>

      {userScrolledUp && (
        <button
          onClick={() => {
            setUserScrolledUp(false);
            bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
          }}
          className="absolute bottom-4 right-4 p-2 rounded-full bg-bg-secondary border border-border-subtle text-text-secondary hover:text-text-primary shadow-lg cursor-pointer transition-colors"
        >
          <ArrowDown size={14} />
        </button>
      )}
    </div>
  );
}

function LogEntry({ entry }: { entry: TaskLogEntry }) {
  if (entry.kind === 'text_delta') {
    return <span className="text-zinc-400 whitespace-pre-wrap">{entry.text}</span>;
  }
  if (entry.kind === 'tool_start') {
    return (
      <div className="my-1 flex items-center gap-1.5 text-accent/70">
        <Wrench size={11} />
        <span className="font-semibold">{entry.toolName}</span>
        {entry.toolName === 'Write' || entry.toolName === 'Edit' ? (
          <span className="text-text-tertiary">
            {typeof entry.args === 'object' && entry.args && 'file_path' in entry.args
              ? String((entry.args as Record<string, unknown>).file_path)
              : ''}
          </span>
        ) : null}
      </div>
    );
  }
  if (entry.kind === 'tool_end') {
    const truncated = entry.result.length > 300
      ? entry.result.slice(0, 300) + '...'
      : entry.result;
    return (
      <div className={clsx('ml-4 my-0.5', entry.isError ? 'text-red-400' : 'text-zinc-600')}>
        {truncated}
      </div>
    );
  }
  if (entry.kind === 'phase_start') {
    return (
      <div className="my-2 py-1 border-t border-zinc-800 text-yellow-500/80 font-semibold">
        --- Phase: {entry.name} ---
      </div>
    );
  }
  if (entry.kind === 'phase_end') {
    return (
      <div className="my-1 border-b border-zinc-800 text-green-500/60 text-[10px]">
        --- Phase complete ---
      </div>
    );
  }
  if (entry.kind === 'error') {
    return (
      <div className="my-1 flex items-center gap-1.5 text-red-400">
        <AlertTriangle size={11} />
        <span>{entry.message}</span>
      </div>
    );
  }
  if (entry.kind === 'system') {
    return (
      <div className="my-0.5 text-zinc-600 italic">{entry.message}</div>
    );
  }
  return null;
}
