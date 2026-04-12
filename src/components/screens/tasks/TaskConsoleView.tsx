/**
 * TaskConsoleView — real terminal powered by xterm.js + node-pty.
 *
 * Subscribes to raw PTY data from the main process via IPC and writes
 * it directly to xterm. This is the EXACT Claude Code CLI output —
 * colors, tool boxes, spinners, everything.
 *
 * For completed tasks, replays persisted events (text_delta) to
 * reconstruct the terminal view from history.
 *
 * Follows Turbo's XTermRenderer patterns.
 */

import { useRef, useEffect, useState, useCallback } from 'react';
import { ArrowDown } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { getTaskTerminalBuffer } from './taskTerminalBuffer';
import type { Task, TaskLogEntry } from './types';

interface TaskConsoleViewProps {
  task: Task;
  liveTask: {
    taskId: string;
    runId: string;
    logEntries: TaskLogEntry[];
  } | null;
}

const THEME = {
  background: '#0a0a0f',
  foreground: '#e4e4ef',
  cursor: '#e4e4ef',
  cursorAccent: '#0a0a0f',
  selectionBackground: '#06b6d440',
  selectionForeground: undefined,
  black: '#18181b',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#f59e0b',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: '#e4e4ef',
  brightBlack: '#55556a',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#fbbf24',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#22d3ee',
  brightWhite: '#ffffff',
};

export default function TaskConsoleView({ task, liveTask }: TaskConsoleViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const subscribedRunIdRef = useRef<string | null>(null);
  // Track how many historical logEntries we've written (for fallback replay)
  const historicalWrittenRef = useRef(0);

  const isLive = liveTask?.taskId === task.id;
  const runId = isLive ? liveTask!.runId : task.run_id;

  // Track last-sent PTY dims to skip no-op resize IPC (same as Turbo)
  const lastColsRef = useRef(0);
  const lastRowsRef = useRef(0);

  const safeFit = useCallback(() => {
    const el = containerRef.current;
    if (el && el.clientWidth > 0 && el.clientHeight > 0) {
      try {
        fitRef.current?.fit();
        // Force full redraw after fit to prevent stale pixels (Turbo pattern)
        termRef.current?.refresh(0, (termRef.current?.rows ?? 1) - 1);
      } catch { /* detached */ }
    }
  }, []);

  const sendResizeIfChanged = useCallback(() => {
    const terminal = termRef.current;
    if (!terminal || !runId) return;
    const { cols, rows } = terminal;
    if (cols === lastColsRef.current && rows === lastRowsRef.current) return;
    lastColsRef.current = cols;
    lastRowsRef.current = rows;
    window.cerebro.taskTerminal.resize(runId, cols, rows);
  }, [runId]);

  // ── Terminal lifecycle ─────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;

    const terminal = new Terminal({
      convertEol: true,
      disableStdin: true,
      scrollback: 10_000,
      fontSize: 13,
      fontFamily: "'Geist Mono', 'SF Mono', 'Menlo', ui-monospace, monospace",
      lineHeight: 1.4,
      cursorBlink: false,
      allowProposedApi: true,
      theme: THEME,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);

    termRef.current = terminal;
    fitRef.current = fitAddon;
    subscribedRunIdRef.current = null;
    historicalWrittenRef.current = 0;

    requestAnimationFrame(() => {
      if (!disposed) {
        safeFit();
        sendResizeIfChanged();
      }
    });

    terminal.onScroll(() => {
      if (disposed) return;
      const buf = terminal.buffer.active;
      setShowScrollBtn(buf.viewportY < buf.baseY);
    });

    const handleWindowFocus = () => {
      const buf = terminal.buffer.active;
      if (buf.viewportY >= buf.baseY) return;
      const target = buf.viewportY;
      requestAnimationFrame(() => {
        if (disposed) return;
        const current = terminal.buffer.active.viewportY;
        if (current !== target) terminal.scrollLines(target - current);
      });
    };
    window.addEventListener('focus', handleWindowFocus);

    let resizePending = false;
    const observer = new ResizeObserver(() => {
      if (resizePending || disposed) return;
      resizePending = true;
      requestAnimationFrame(() => {
        resizePending = false;
        if (!disposed) {
          safeFit();
          sendResizeIfChanged();
        }
      });
    });
    observer.observe(containerRef.current);

    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener('focus', handleWindowFocus);
      try { fitAddon.dispose(); } catch { /* teardown race */ }
      terminal.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [task.id, safeFit, sendResizeIfChanged]);

  // ── PTY data: buffer replay + live subscription ─────────────
  // Same pattern as Turbo's XTermRenderer: replay buffered data
  // FIRST (captured globally by TaskContext), THEN subscribe to
  // live data. Single-threaded JS ensures no gap between the two.

  useEffect(() => {
    const terminal = termRef.current;
    if (!terminal || !runId) return;
    if (subscribedRunIdRef.current === runId) return;

    let unsub: (() => void) | null = null;
    let localDisposed = false;

    requestAnimationFrame(() => {
      if (localDisposed || !termRef.current) return;

      // 1. Replay any buffered data from before this component mounted
      const buffered = getTaskTerminalBuffer(runId);
      if (buffered) {
        termRef.current.write(buffered);
      }

      // 2. NOW subscribe to live data — buffer replay complete, no duplicates
      if (isLive) {
        unsub = window.cerebro.taskTerminal.onData(runId, (data: string) => {
          if (termRef.current) termRef.current.write(data);
        });
        subscribedRunIdRef.current = runId;
      }
    });

    return () => {
      localDisposed = true;
      unsub?.();
      subscribedRunIdRef.current = null;
    };
  }, [runId, isLive]);

  // ── Replay historical events for completed tasks ────────────
  // For tasks that are no longer live, replay text_delta entries
  // from logEntries as plain text. This won't have full CLI
  // formatting but shows the content.

  useEffect(() => {
    const terminal = termRef.current;
    if (!terminal || isLive) return;

    const entries = liveTask?.taskId === task.id ? liveTask.logEntries : [];
    if (entries.length === 0) return;

    const count = entries.length;
    if (count <= historicalWrittenRef.current) return;

    // Write only new entries
    for (let i = historicalWrittenRef.current; i < count; i++) {
      const entry = entries[i];
      if (entry.kind === 'text_delta') {
        terminal.write(entry.text);
      }
    }
    historicalWrittenRef.current = count;
  });

  const handleScrollToBottom = useCallback(() => {
    termRef.current?.scrollToBottom();
    setShowScrollBtn(false);
  }, []);

  // Show empty state only if no live task and no historical data
  const hasEntries = isLive || (liveTask?.taskId === task.id && liveTask.logEntries.length > 0);
  if (!hasEntries && !isLive) {
    const isRunning = task.status === 'running' || task.status === 'clarifying';
    return (
      <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm py-16">
        {isRunning ? 'Waiting for output...' : 'No output'}
      </div>
    );
  }

  return (
    <div className="relative w-full h-full" style={{ padding: '4px' }}>
      <div
        ref={containerRef}
        className="w-full h-full"
      />
      {showScrollBtn && (
        <button
          onClick={handleScrollToBottom}
          className="absolute bottom-4 right-4 p-2 rounded-full bg-bg-secondary border border-border-subtle text-text-secondary hover:text-text-primary shadow-lg cursor-pointer transition-colors z-10"
        >
          <ArrowDown size={14} />
        </button>
      )}
    </div>
  );
}
