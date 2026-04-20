import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal as TerminalIcon } from 'lucide-react';
import clsx from 'clsx';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

interface ExpertConsoleProps {
  runId: string | null;
  className?: string;
}

/**
 * How much of the persisted buffer to re-play after a cols change. Claude
 * Code's TUI redraws with cursor-up sequences sized for the cols that were
 * in effect when each frame was written, so playing back the full historical
 * buffer at a different cols inevitably stacks frames. Replaying just the
 * tail keeps the most recent frame visible (good UX for paused tasks) while
 * bounding the potential for visible artifacts.
 */
const REPLAY_TAIL_BYTES = 30_000;

/**
 * Real xterm.js terminal wired to the Expert's live PTY output.
 * Replays persisted terminal buffer on mount, then streams new data live.
 */
export default function ExpertConsole({ runId, className }: ExpertConsoleProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!runId || !containerRef.current) return;

    const term = new Terminal({
      fontFamily: '"Geist Mono", Menlo, Monaco, "Courier New", monospace',
      fontSize: 12.5,
      lineHeight: 1.3,
      cursorBlink: true,
      scrollback: 5000,
      convertEol: true,
      allowTransparency: false,
      theme: {
        background: '#09090B',
        foreground: '#E4E4E7',
        cursor: '#06B6D4',
        cursorAccent: '#09090B',
        selectionBackground: '#06B6D4',
        selectionForeground: '#09090B',
        black: '#18181B',
        red: '#F87171',
        green: '#34D399',
        yellow: '#FBBF24',
        blue: '#60A5FA',
        magenta: '#C084FC',
        cyan: '#06B6D4',
        white: '#E4E4E7',
        brightBlack: '#52525B',
        brightRed: '#FCA5A5',
        brightGreen: '#6EE7B7',
        brightYellow: '#FCD34D',
        brightBlue: '#93C5FD',
        brightMagenta: '#D8B4FE',
        brightCyan: '#67E8F9',
        brightWhite: '#FAFAFA',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(containerRef.current);
    termRef.current = term;
    fitAddonRef.current = fitAddon;

    let disposed = false;

    // Tail of the persisted buffer — used to re-seed the terminal after a
    // cols change (see doFit). Kept in a ref-like local so the ResizeObserver
    // callback has access. Populated from readBuffer on mount and updated
    // continuously from live data below.
    let bufferTail = '';
    const appendToTail = (chunk: string) => {
      if (!chunk) return;
      bufferTail = (bufferTail + chunk).slice(-REPLAY_TAIL_BYTES);
    };

    // Responsive resize. Claude Code writes frames sized for the PTY's cols,
    // and xterm's automatic reflow of scrollback on cols-change breaks those
    // frames (cursor-positioning escapes no longer line up). To stay cleanly
    // responsive:
    //   1. Fit cols+rows to the container.
    //   2. On cols change, reset the terminal to eliminate any stale
    //      scrollback that was written at the old cols — xterm has nothing
    //      to reflow, so no garbling.
    //   3. SIGWINCH the PTY so Claude Code repaints at the new size (for
    //      live tasks, the repaint arrives via the onData stream on top of
    //      the clean terminal — no artifacts).
    //   4. Re-seed the terminal with a compact tail of the persisted buffer
    //      so paused/completed tasks still show their most recent frame.
    //      The tail is small enough that any residual width mismatch is
    //      bounded to a few frames rather than the entire history.
    let lastSyncedCols = term.cols;
    let lastSyncedRows = term.rows;
    let haveDoneInitialFit = false;

    const doFit = (opts: { force?: boolean } = {}) => {
      const el = containerRef.current;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      try {
        const proposed = fitAddon.proposeDimensions();
        if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return;
        const nextCols = Math.max(20, proposed.cols);
        const nextRows = Math.max(10, proposed.rows);
        const colsChanged = nextCols !== term.cols;
        const rowsChanged = nextRows !== term.rows;
        if (!colsChanged && !rowsChanged && !opts.force) return;

        if (colsChanged && haveDoneInitialFit) {
          // Wipe existing content — xterm's auto-reflow at a new cols would
          // corrupt frames that relied on the old cols for cursor math.
          term.reset();
        }

        term.resize(nextCols, nextRows);

        if (nextCols !== lastSyncedCols || nextRows !== lastSyncedRows) {
          lastSyncedCols = nextCols;
          lastSyncedRows = nextRows;
          window.cerebro.taskTerminal.resize(runId, nextCols, nextRows);
        }

        if (colsChanged && haveDoneInitialFit && bufferTail) {
          // Re-seed with the tail so the most recent frame(s) are visible
          // again at the new cols. Live tasks will overwrite this with
          // their SIGWINCH-triggered repaint within a frame or two.
          term.write(bufferTail);
        }
        haveDoneInitialFit = true;
      } catch { /* noop */ }
    };
    doFit({ force: true });

    // Replay persisted buffer (survives app restart). We keep the tail for
    // re-seeding on subsequent cols changes.
    (async () => {
      try {
        const buf = await window.cerebro.taskTerminal.readBuffer(runId);
        if (!disposed && buf) {
          appendToTail(buf);
          term.write(buf);
        }
      } catch (err) {
        console.warn('[ExpertConsole] Failed to replay buffer:', err);
      }
    })();

    // Live data stream
    const unsubData = window.cerebro.taskTerminal.onData(runId, (data: string) => {
      if (disposed) return;
      appendToTail(data);
      term.write(data);
    });
    // Also listen on the global channel (some runs emit there)
    const unsubGlobal = window.cerebro.taskTerminal.onGlobalData((id, data) => {
      if (disposed || id !== runId) return;
      appendToTail(data);
      term.write(data);
    });

    // Forward user keystrokes to the PTY stdin
    const keyDisposable = term.onData((data) => {
      window.cerebro.taskTerminal.sendInput(runId, data);
    });

    // Debounced resize — the drawer's width transition fires dozens of
    // ResizeObserver callbacks; we only want one fit per settled size.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        doFit();
      }, 220);
    });
    ro.observe(containerRef.current);

    return () => {
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      ro.disconnect();
      keyDisposable.dispose();
      unsubData();
      unsubGlobal();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [runId]);

  if (!runId) {
    return (
      <div className={clsx('w-full h-full bg-[#09090B] flex items-center justify-center', className)}>
        <div className="flex flex-col items-center gap-3 text-zinc-500">
          <TerminalIcon size={32} className="opacity-50" />
          <p className="text-sm">{t('tasks.consolePlaceholder')}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={clsx('w-full h-full bg-[#09090B] overflow-hidden', className)}
    />
  );
}
