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

    // Size to container
    const initialFit = () => {
      try {
        fitAddon.fit();
        window.cerebro.taskTerminal.resize(runId, term.cols, term.rows);
      } catch { /* noop */ }
    };
    initialFit();

    // Replay persisted buffer (survives app restart)
    let disposed = false;
    (async () => {
      try {
        const buf = await window.cerebro.taskTerminal.readBuffer(runId);
        if (!disposed && buf) term.write(buf);
      } catch (err) {
        console.warn('[ExpertConsole] Failed to replay buffer:', err);
      }
    })();

    // Live data stream
    const unsubData = window.cerebro.taskTerminal.onData(runId, (data: string) => {
      if (!disposed) term.write(data);
    });
    // Also listen on the global channel (some runs emit there)
    const unsubGlobal = window.cerebro.taskTerminal.onGlobalData((id, data) => {
      if (!disposed && id === runId) term.write(data);
    });

    // Forward user keystrokes to the PTY stdin
    const keyDisposable = term.onData((data) => {
      window.cerebro.taskTerminal.sendInput(runId, data);
    });

    // Resize observer to keep terminal fit to its container
    const ro = new ResizeObserver(() => {
      try {
        fitAddon.fit();
        window.cerebro.taskTerminal.resize(runId, term.cols, term.rows);
      } catch { /* noop */ }
    });
    ro.observe(containerRef.current);

    return () => {
      disposed = true;
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
      <div className={clsx('flex-1 flex items-center justify-center', className)}>
        <div className="flex flex-col items-center gap-3 text-text-tertiary">
          <TerminalIcon size={32} className="opacity-40" />
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
