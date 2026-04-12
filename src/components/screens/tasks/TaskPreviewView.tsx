/**
 * TaskPreviewView — live preview of the built app.
 *
 * For web apps: auto-starts the dev server and shows an embedded iframe.
 * For static HTML: loads index.html directly via blob URL.
 * Shows the end product — the user sees the actual running app.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Play, Square, Loader2, ExternalLink, RefreshCw, RotateCcw } from 'lucide-react';
import type { Task, TaskDetail } from './types';

interface TaskPreviewViewProps {
  task: Task;
  detail: TaskDetail | null;
}

type ServerState = 'stopped' | 'starting' | 'running' | 'error';

export default function TaskPreviewView({ task, detail }: TaskPreviewViewProps) {
  const [state, setState] = useState<ServerState>('stopped');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isRunning = task.status === 'running' || task.status === 'clarifying' || task.status === 'planning';

  // Hydrate from existing dev server state
  useEffect(() => {
    if (detail?.dev_server?.running && detail.dev_server.url) {
      setState('running');
      setUrl(detail.dev_server.url);
    }
  }, [detail?.dev_server]);

  // Auto-start on mount if task is complete and has run_info
  useEffect(() => {
    if (!isRunning && state === 'stopped' && task.run_info && !detail?.dev_server?.running) {
      handleStart();
    }
    return () => {
      stopPolling();
      if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null; }
    };
  }, []);

  const blobUrlRef = useRef<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
  }, []);

  const handleStart = useCallback(async () => {
    stopPolling();
    setState('starting');
    setError(null);
    setUrl(null);
    // Revoke previous blob URL to prevent memory leak
    if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null; }

    try {
      if (task.run_info?.preview_type === 'static') {
        const res = await window.cerebro.invoke<{ content: string }>({
          method: 'GET',
          path: `/tasks/${task.id}/workspace/file?path=index.html`,
        });
        if (res.ok && res.data?.content) {
          const blobUrl = URL.createObjectURL(new Blob([res.data.content], { type: 'text/html' }));
          blobUrlRef.current = blobUrl;
          setUrl(blobUrl);
          setState('running');
          return;
        }
      }

      const res = await window.cerebro.invoke<{ task_id: string; pid: number }>({
        method: 'POST',
        path: `/tasks/${task.id}/dev-server/start`,
      });

      if (!res.ok) {
        setState('error');
        setError('Failed to start preview server');
        return;
      }

      pollRef.current = setInterval(async () => {
        const status = await window.cerebro.invoke<{
          running: boolean;
          url: string | null;
        }>({
          method: 'GET',
          path: `/tasks/${task.id}/dev-server/status`,
        });

        if (status.ok && status.data) {
          if (status.data.url) {
            setUrl(status.data.url);
            setState('running');
            stopPolling();
          }
          if (!status.data.running) {
            setState('error');
            setError('Preview server stopped unexpectedly');
            stopPolling();
          }
        }
      }, 1000);

      timeoutRef.current = setTimeout(() => stopPolling(), 90_000);
    } catch {
      setState('error');
      setError('Failed to start preview server');
    }
  }, [task.id, task.run_info, stopPolling]);

  const handleStop = useCallback(async () => {
    if (pollRef.current) clearInterval(pollRef.current);
    await window.cerebro.invoke({
      method: 'POST',
      path: `/tasks/${task.id}/dev-server/stop`,
    });
    setState('stopped');
    setUrl(null);
  }, [task.id]);

  const handleReload = useCallback(() => {
    if (iframeRef.current && url) {
      iframeRef.current.src = url;
    }
  }, [url]);

  // Task still running
  if (isRunning) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-text-tertiary text-sm">
        <Loader2 size={18} className="animate-spin mb-2" />
        <span>Preview will be available when the task completes</span>
      </div>
    );
  }

  // Starting
  if (state === 'starting') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-text-tertiary text-sm">
        <Loader2 size={20} className="animate-spin mb-3" />
        <span>Starting preview...</span>
        {task.run_info?.start_command && (
          <code className="text-xs mt-1 text-text-tertiary font-mono">
            {task.run_info.start_command}
          </code>
        )}
      </div>
    );
  }

  // Error
  if (state === 'error') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-text-tertiary text-sm gap-3">
        <span className="text-red-400">{error || 'Preview failed'}</span>
        <button
          onClick={handleStart}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-bg-secondary text-text-secondary hover:text-text-primary text-xs cursor-pointer transition-colors"
        >
          <RotateCcw size={12} /> Retry
        </button>
      </div>
    );
  }

  // Running with URL — show iframe
  if (url) {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        {/* Browser bar */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border-subtle bg-bg-surface">
          <div className="flex items-center gap-1">
            <button
              onClick={handleReload}
              className="p-1 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-secondary cursor-pointer transition-colors"
              title="Reload"
            >
              <RefreshCw size={12} />
            </button>
            <button
              onClick={handleStop}
              className="p-1 rounded hover:bg-bg-hover text-text-tertiary hover:text-red-400 cursor-pointer transition-colors"
              title="Stop server"
            >
              <Square size={12} />
            </button>
          </div>
          <div className="flex-1 px-2 py-0.5 rounded bg-bg-base border border-border-subtle text-xs text-text-tertiary font-mono truncate">
            {url.startsWith('blob:') ? 'index.html' : url}
          </div>
          {!url.startsWith('blob:') && (
            <button
              onClick={() => window.open(url, '_blank')}
              className="p-1 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-secondary cursor-pointer transition-colors"
              title="Open in browser"
            >
              <ExternalLink size={12} />
            </button>
          )}
        </div>

        <iframe
          ref={iframeRef}
          src={url}
          className="flex-1 w-full bg-white border-0"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          title="App preview"
        />
      </div>
    );
  }

  // Stopped — no run_info or not started
  if (!task.run_info) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">
        No preview available for this task
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center text-text-tertiary text-sm gap-3">
      <button
        onClick={handleStart}
        className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium cursor-pointer hover:bg-accent/80 transition-colors"
      >
        <Play size={14} /> Start Preview
      </button>
    </div>
  );
}
