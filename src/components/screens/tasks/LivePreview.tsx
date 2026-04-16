import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, ExternalLink, Eye } from 'lucide-react';
import clsx from 'clsx';

interface LivePreviewProps {
  taskId: string;
  runId: string | null;
  className?: string;
}

type PreviewSource = 'static' | 'dev_server';

/**
 * Live iframe preview of the agent's workspace output.
 *
 * Strategy:
 * 1. Default — show {taskId}/index.html via the cerebro-workspace:// protocol.
 * 2. As the agent runs, scan terminal output for dev-server URLs
 *    (from <run_info> blocks or common localhost patterns).
 * 3. When a URL is detected, switch iframe src to the live dev server.
 */
export default function LivePreview({ taskId, runId, className }: LivePreviewProps) {
  const { t } = useTranslation();

  const staticUrl = `cerebro-workspace://${taskId}/index.html`;
  const [previewUrl, setPreviewUrl] = useState<string>(staticUrl);
  const [source, setSource] = useState<PreviewSource>('static');
  const [iframeKey, setIframeKey] = useState(0); // bump to force reload
  const [hasIndexFile, setHasIndexFile] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Probe the workspace for an index.html so we don't iframe a 404
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        const tree = await window.cerebro.taskTerminal.listFiles(taskId);
        if (cancelled) return;
        const has = tree.some((n) => n.name === 'index.html' && n.type === 'file');
        setHasIndexFile(has);
      } catch {
        if (!cancelled) setHasIndexFile(false);
      }
    };
    probe();
    // Re-probe periodically while the run is active
    if (runId && source === 'static') {
      const id = setInterval(probe, 3000);
      return () => { cancelled = true; clearInterval(id); };
    }
    return () => { cancelled = true; };
  }, [taskId, runId, source, iframeKey]);

  // Buffer for accumulating agent text to scan for URLs / <run_info> blocks.
  const textBufferRef = useRef('');
  // Sticky flag so we stop scanning once a dev-server URL is detected.
  const hasDetectedRef = useRef(false);

  // Detect a dev-server URL from agent text output
  const detectUrlFromText = useCallback((text: string): string | null => {
    // Prefer <run_info> block with preview_url_pattern if emitted
    const runInfoMatch = text.match(/<run_info>\s*([\s\S]*?)\s*<\/run_info>/);
    if (runInfoMatch) {
      try {
        const info = JSON.parse(runInfoMatch[1]) as {
          preview_url_pattern?: string;
          start_command?: string;
          preview_type?: string;
        };
        if (info.preview_url_pattern) {
          const pat = new RegExp(info.preview_url_pattern);
          const m = text.match(pat);
          if (m) return m[1] || m[0];
        }
      } catch {
        /* ignore malformed run_info */
      }
    }

    // Fallback: common patterns from popular dev servers
    const patterns = [
      /Local:\s+(https?:\/\/[^\s]+)/,             // Vite
      /ready\s+-\s+started\s+server\s+on\s+(https?:\/\/[^\s]+)/i, // Next.js
      /(http:\/\/localhost:\d+)/,
      /(http:\/\/127\.0\.0\.1:\d+)/,
      /(http:\/\/0\.0\.0\.0:\d+)/,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return m[1] || m[0];
    }
    return null;
  }, []);

  // Subscribe to agent text deltas to detect dev server URLs.
  // Note: `source` is NOT in deps — we read hasDetectedRef instead so the
  // subscription doesn't tear down (and lose buffered text) when source flips.
  useEffect(() => {
    if (!runId) return;
    textBufferRef.current = '';
    hasDetectedRef.current = false;
    const unsub = window.cerebro.agent.onEvent(runId, (event) => {
      if (hasDetectedRef.current) return;
      if (event.type === 'text_delta' && event.delta) {
        textBufferRef.current += event.delta;
        if (textBufferRef.current.length > 200_000) {
          textBufferRef.current = textBufferRef.current.slice(-100_000);
        }
        const url = detectUrlFromText(textBufferRef.current);
        if (url) {
          hasDetectedRef.current = true;
          setPreviewUrl(url);
          setSource('dev_server');
        }
      }
    });
    return () => unsub();
  }, [runId, detectUrlFromText]);

  // Auto-refresh the static preview periodically while a run is active
  // (so users see files update as the agent writes them)
  useEffect(() => {
    if (!runId || source === 'dev_server') return;
    const id = setInterval(() => setIframeKey((k) => k + 1), 3000);
    return () => clearInterval(id);
  }, [runId, source]);

  const handleRefresh = () => {
    if (source === 'static') {
      setIframeKey((k) => k + 1);
    } else if (iframeRef.current) {
      // Dev server: reload by resetting src
      iframeRef.current.src = previewUrl;
    }
  };

  const handleOpenExternal = () => {
    if (source === 'dev_server') {
      window.open(previewUrl, '_blank');
    }
  };

  const handleResetToStatic = () => {
    setPreviewUrl(staticUrl);
    setSource('static');
    setIframeKey((k) => k + 1);
  };

  return (
    <div className={clsx('flex flex-col h-full bg-bg-base', className)}>
      {/* Toolbar */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border-subtle bg-bg-surface">
        <Eye size={14} className="text-text-tertiary flex-shrink-0" />
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span
            className={clsx(
              'text-[10px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0',
              source === 'dev_server'
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'bg-zinc-600/30 text-zinc-400',
            )}
          >
            {source === 'dev_server' ? t('tasks.previewLive') : t('tasks.previewFiles')}
          </span>
          <span className="text-xs text-text-tertiary truncate font-mono">{previewUrl}</span>
        </div>
        {source === 'dev_server' && (
          <button
            onClick={handleResetToStatic}
            className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
            title={t('tasks.previewShowFiles')}
          >
            <Eye size={14} />
          </button>
        )}
        <button
          onClick={handleRefresh}
          className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          title={t('tasks.previewRefresh')}
        >
          <RefreshCw size={14} />
        </button>
        {source === 'dev_server' && (
          <button
            onClick={handleOpenExternal}
            className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
            title={t('tasks.previewOpenExternal')}
          >
            <ExternalLink size={14} />
          </button>
        )}
      </div>

      {/* Iframe — only shown when there's content to render */}
      <div className="flex-1 min-h-0 bg-white">
        {source === 'dev_server' || hasIndexFile ? (
          <iframe
            key={iframeKey}
            ref={iframeRef}
            src={previewUrl}
            className="w-full h-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
            title="Live preview"
          />
        ) : (
          <div className="w-full h-full bg-bg-base flex flex-col items-center justify-center gap-3 text-text-tertiary p-10 text-center">
            <Eye size={36} className="opacity-30" />
            <p className="text-sm font-medium">{t('tasks.previewWaiting')}</p>
            <p className="text-xs max-w-md">{t('tasks.previewWaitingHint')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
