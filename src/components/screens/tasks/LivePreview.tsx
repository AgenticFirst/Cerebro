import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, ExternalLink, Eye, FolderOpen, Copy, Check, ArrowLeft } from 'lucide-react';
import clsx from 'clsx';
import { flattenFiles } from '../../../utils/workspace-tree';
import type { ParsedDeliverable, WorkspaceFileNode } from '../../../types/ipc';
import MarkdownContent from '../../chat/MarkdownContent';
import { kindForFile, type PreviewKind, treeFingerprint } from './file-preview-helpers';

interface LivePreviewProps {
  taskId: string;
  runId: string | null;
  /** Whether the task is actively running (in_progress with a live agent). */
  isRunning?: boolean;
  /** External project folder (if the task has one). Used when probing for files. */
  projectPath?: string | null;
  /** Parsed deliverable from the latest successful run, persisted on `tasks`.
   * When present this is the primary view; live artifact detection is only
   * relevant while the run is still in flight. */
  deliverable?: ParsedDeliverable | null;
  /** Wired by the parent drawer to switch tabs from the empty-state CTA. */
  onJumpToFiles?: () => void;
  className?: string;
}

interface ArtifactPreview {
  kind: Exclude<PreviewKind, 'dev_server' | 'text'>;
  relativePath: string;
  mtime?: number;
}

const ARTIFACT_PRIORITY: ArtifactPreview['kind'][] = ['static', 'video', 'pdf', 'image', 'audio'];

/** Pick the best in-workspace artifact for the auto-preview path: only
 * renderable formats, shallowest first, then most recent mtime. Source/text
 * files are deliberately excluded — when none of the priority artifacts exist
 * we now show the deliverable or the empty state, not an arbitrary file. */
function pickArtifact(tree: WorkspaceFileNode[]): ArtifactPreview | null {
  const files = flattenFiles(tree);
  const candidates: Array<{ kind: ArtifactPreview['kind']; relativePath: string; depth: number; mtime: number }> = [];
  for (const f of files) {
    const kind = kindForFile(f.name);
    if (!kind || kind === 'text') continue;
    candidates.push({
      kind: kind as ArtifactPreview['kind'],
      relativePath: f.path,
      depth: (f.path.match(/[\\/]/g) ?? []).length,
      mtime: f.mtime ?? 0,
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const pa = ARTIFACT_PRIORITY.indexOf(a.kind);
    const pb = ARTIFACT_PRIORITY.indexOf(b.kind);
    if (pa !== pb) return pa - pb;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return b.mtime - a.mtime;
  });
  return { kind: candidates[0].kind, relativePath: candidates[0].relativePath, mtime: candidates[0].mtime };
}

/**
 * Result-first preview of a task.
 *
 * Strategy, in order:
 *   1. Dev-server URL detected in agent text → iframe (live code_app demo).
 *   2. Persisted deliverable (`resultMd` + `resultKind`) → render markdown
 *      and/or artifact based on kind. This is the primary view post-completion.
 *   3. Live run with no deliverable yet → auto-pick a renderable artifact.
 *   4. Empty state with a CTA to the Files tab when the workspace has files
 *      but none are directly renderable.
 */
export default function LivePreview({
  taskId,
  runId,
  isRunning = false,
  projectPath,
  deliverable,
  onJumpToFiles,
  className,
}: LivePreviewProps) {
  const { t } = useTranslation();

  const isExternalProject = !!projectPath;
  const resultMd = deliverable?.body ?? null;
  const resultTitle = deliverable?.title ?? null;
  const resultKind = deliverable?.kind ?? null;
  const hasResult = !!(resultMd && resultMd.trim());

  const [tree, setTree] = useState<WorkspaceFileNode[]>([]);
  const [autoArtifact, setAutoArtifact] = useState<ArtifactPreview | null>(null);
  const [devServerUrl, setDevServerUrl] = useState<string | null>(null);
  const [probeKey, setProbeKey] = useState(0);
  const [iframeKey, setIframeKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const treeFpRef = useRef('');

  // Workspace probe — needed only when we'll potentially auto-pick an artifact
  // (live runs without a deliverable yet, or code_app/mixed deliverables that
  // surface a file alongside the markdown). For pure markdown deliverables we
  // skip it to avoid an unnecessary 3 s poll loop.
  const needsArtifactProbe = !isExternalProject && (
    !hasResult || resultKind === 'code_app' || resultKind === 'mixed'
  );
  useEffect(() => {
    if (!needsArtifactProbe) {
      setTree([]);
      setAutoArtifact(null);
      treeFpRef.current = '';
      return;
    }
    let cancelled = false;
    const probe = async () => {
      try {
        const next = await window.cerebro.taskTerminal.listFiles(taskId);
        if (cancelled) return;
        const fp = treeFingerprint(next);
        if (fp !== treeFpRef.current) {
          treeFpRef.current = fp;
          setTree(next);
        }
        const picked = pickArtifact(next);
        setAutoArtifact((prev) => {
          if (
            prev?.kind === picked?.kind
            && prev?.relativePath === picked?.relativePath
            && prev?.mtime === picked?.mtime
          ) return prev;
          return picked;
        });
      } catch {
        if (!cancelled) { setTree([]); setAutoArtifact(null); treeFpRef.current = ''; }
      }
    };
    probe();
    if (isRunning) {
      const id = setInterval(probe, 3000);
      return () => { cancelled = true; clearInterval(id); };
    }
    return () => { cancelled = true; };
  }, [taskId, isRunning, needsArtifactProbe, probeKey]);

  // Dev-server URL detection from streaming agent text (unchanged from before).
  const textBufferRef = useRef('');
  const hasDetectedRef = useRef(false);
  const detectUrlFromText = useCallback((text: string): string | null => {
    const stripTrailingPunct = (url: string): string =>
      url.replace(/[.,;:!?)"'>\]}]+$/, '');
    const runInfoMatch = text.match(/<run_info>\s*([\s\S]*?)\s*<\/run_info>/);
    if (runInfoMatch) {
      try {
        const info = JSON.parse(runInfoMatch[1]) as { preview_url_pattern?: string };
        if (info.preview_url_pattern) {
          const pat = new RegExp(info.preview_url_pattern);
          const m = text.match(pat);
          if (m) return stripTrailingPunct(m[1] || m[0]);
        }
      } catch { /* ignore malformed run_info */ }
    }
    const patterns = [
      /Local:\s+(https?:\/\/[^\s]+)/,
      /ready\s+-\s+started\s+server\s+on\s+(https?:\/\/[^\s]+)/i,
      /(http:\/\/localhost:\d+)/,
      /(http:\/\/127\.0\.0\.1:\d+)/,
      /(http:\/\/0\.0\.0\.0:\d+)/,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return stripTrailingPunct(m[1] || m[0]);
    }
    return null;
  }, []);

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
          setDevServerUrl(url);
        }
      }
    });
    return () => unsub();
  }, [runId, detectUrlFromText]);

  // Reload iframe when underlying file mtime moves forward.
  const mtimeSeenRef = useRef<number | undefined>(undefined);
  const pathSeenRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (devServerUrl) return;
    if (!autoArtifact) {
      mtimeSeenRef.current = undefined;
      pathSeenRef.current = undefined;
      return;
    }
    const pathChanged = pathSeenRef.current !== autoArtifact.relativePath;
    const mtimeChanged = mtimeSeenRef.current !== undefined
      && autoArtifact.mtime !== undefined
      && mtimeSeenRef.current !== autoArtifact.mtime;
    if (pathChanged) {
      pathSeenRef.current = autoArtifact.relativePath;
      mtimeSeenRef.current = autoArtifact.mtime;
      return;
    }
    if (mtimeChanged) {
      mtimeSeenRef.current = autoArtifact.mtime;
      setIframeKey((k) => k + 1);
    }
  }, [devServerUrl, autoArtifact]);

  const handleRefresh = useCallback(() => {
    setProbeKey((k) => k + 1);
    setIframeKey((k) => k + 1);
    if (devServerUrl && iframeRef.current) {
      iframeRef.current.src = devServerUrl;
    }
  }, [devServerUrl]);

  const handleOpenExternal = useCallback(async () => {
    if (devServerUrl) {
      window.open(devServerUrl, '_blank');
      return;
    }
    try {
      const wsPath = projectPath
        ? projectPath
        : await window.cerebro.taskTerminal.getWorkspacePath(taskId);
      await window.cerebro.sandbox.revealWorkspace(wsPath);
    } catch (err) {
      console.warn('[LivePreview] Failed to reveal workspace:', err);
    }
  }, [devServerUrl, projectPath, taskId]);

  const handleResetToAuto = useCallback(() => {
    setDevServerUrl(null);
    hasDetectedRef.current = false;
    setIframeKey((k) => k + 1);
  }, []);

  const handleCopyResult = useCallback(async () => {
    if (!resultMd) return;
    try {
      await navigator.clipboard.writeText(resultMd);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be denied in some sandboxes — silent fail is fine.
    }
  }, [resultMd]);

  // Compute the rendering branch.
  const hasFiles = useMemo(() => flattenFiles(tree).length > 0, [tree]);
  const artifactUrl = autoArtifact
    ? `cerebro-workspace://${taskId}/${autoArtifact.relativePath}`
    : '';
  const showDevServer = !!devServerUrl;
  const showResultMarkdown = !showDevServer && hasResult && (resultKind === 'markdown' || resultKind === 'mixed');
  const showResultArtifact = !showDevServer && hasResult && (resultKind === 'code_app' || resultKind === 'mixed') && !!autoArtifact;
  const showLiveArtifact = !showDevServer && !hasResult && !!autoArtifact;
  const showEmpty = !showDevServer && !hasResult && !autoArtifact;

  const artifactLabel = (fallback: string): string => {
    switch (autoArtifact?.kind) {
      case 'video': return t('tasks.previewVideo');
      case 'image': return t('tasks.previewImage');
      case 'pdf':   return t('tasks.previewPdf');
      case 'audio': return t('tasks.previewAudio');
      default:      return fallback;
    }
  };
  const badgeLabel =
    showDevServer       ? t('tasks.previewLive')
    : showResultMarkdown ? t('tasks.previewResultTitle')
    : showResultArtifact ? artifactLabel(t('tasks.previewResultTitle'))
    : showLiveArtifact   ? artifactLabel(t('tasks.previewLive'))
    : t('tasks.previewResultTitle');

  const badgeClass = showDevServer
    ? 'bg-emerald-500/15 text-emerald-400'
    : (hasResult || showLiveArtifact)
      ? 'bg-accent/15 text-accent'
      : 'bg-zinc-600/30 text-zinc-400';

  const subtitle = showDevServer
    ? devServerUrl!
    : showResultMarkdown
      ? (resultTitle?.trim() || t('tasks.previewResultUntitled'))
      : showResultArtifact || showLiveArtifact
        ? artifactUrl
        : isExternalProject
          ? t('tasks.previewExternalHint')
          : t('tasks.previewNoArtifact');

  return (
    <div className={clsx('flex flex-col h-full bg-bg-base', className)}>
      {/* Toolbar */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border-subtle bg-bg-surface">
        <Eye size={14} className="text-text-tertiary flex-shrink-0" />
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span
            className={clsx(
              'text-[10px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0',
              badgeClass,
            )}
          >
            {badgeLabel}
          </span>
          <span className="text-xs text-text-tertiary truncate font-mono">
            {subtitle}
          </span>
        </div>
        {showResultMarkdown && (
          <button
            onClick={handleCopyResult}
            className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
            title={copied ? t('tasks.previewResultCopied') : t('tasks.previewResultCopy')}
            aria-label={copied ? t('tasks.previewResultCopied') : t('tasks.previewResultCopy')}
          >
            {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
          </button>
        )}
        {showDevServer && (
          <button
            onClick={handleResetToAuto}
            className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
            title={t('tasks.previewShowFiles')}
            aria-label={t('tasks.previewShowFiles')}
          >
            <ArrowLeft size={14} />
          </button>
        )}
        <button
          onClick={handleRefresh}
          className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          title={t('tasks.previewRefresh')}
          aria-label={t('tasks.previewRefresh')}
        >
          <RefreshCw size={14} />
        </button>
        {(showDevServer || !isExternalProject) && (
          <button
            onClick={handleOpenExternal}
            className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
            title={showDevServer ? t('tasks.previewOpenExternal') : t('tasks.previewRevealWorkspace')}
            aria-label={showDevServer ? t('tasks.previewOpenExternal') : t('tasks.previewRevealWorkspace')}
          >
            {showDevServer ? <ExternalLink size={14} /> : <FolderOpen size={14} />}
          </button>
        )}
      </div>

      {/* Surface */}
      <div className="flex-1 min-h-0 bg-bg-base flex flex-col">
        {showDevServer ? (
          <iframe
            key={iframeKey}
            ref={iframeRef}
            src={devServerUrl!}
            className="w-full h-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
            title="Live preview"
          />
        ) : showResultMarkdown && showResultArtifact ? (
          // mixed deliverable — markdown summary on top, artifact iframe below
          <>
            <div className="flex-shrink-0 max-h-[45%] overflow-y-auto px-6 py-5 border-b border-border-subtle">
              {resultTitle?.trim() && (
                <h2 className="text-sm font-semibold text-text-primary mb-3">{resultTitle.trim()}</h2>
              )}
              <MarkdownContent content={resultMd!} />
            </div>
            <div className="flex-1 min-h-0 bg-white">
              {renderArtifact(autoArtifact!, artifactUrl, iframeKey, iframeRef, mediaRef, t("tasks.previewResultTitle"))}
            </div>
          </>
        ) : showResultMarkdown ? (
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
            {resultTitle?.trim() && (
              <h2 className="text-base font-semibold text-text-primary mb-4">{resultTitle.trim()}</h2>
            )}
            <MarkdownContent content={resultMd!} />
            {hasFiles && onJumpToFiles && (
              <div className="mt-6 pt-4 border-t border-border-subtle">
                <button
                  onClick={onJumpToFiles}
                  className="text-xs text-accent hover:text-accent/80 cursor-pointer transition-colors"
                >
                  {t('tasks.previewSeeAllFiles')}
                </button>
              </div>
            )}
          </div>
        ) : showResultArtifact || showLiveArtifact ? (
          <div className="flex-1 min-h-0 bg-white">
            {renderArtifact(autoArtifact!, artifactUrl, iframeKey, iframeRef, mediaRef, t("tasks.previewResultTitle"))}
          </div>
        ) : showEmpty ? (
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 text-text-tertiary p-10 text-center">
            <Eye size={36} className="opacity-30" />
            <p className="text-sm font-medium max-w-md">
              {isRunning ? t('tasks.previewResultRunning') : t('tasks.previewResultEmpty')}
            </p>
            {hasFiles && onJumpToFiles && (
              <button
                onClick={onJumpToFiles}
                className="mt-2 text-xs text-accent hover:text-accent/80 cursor-pointer transition-colors"
              >
                {t('tasks.previewSeeAllFiles')}
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function renderArtifact(
  artifact: ArtifactPreview,
  url: string,
  iframeKey: number,
  iframeRef: React.MutableRefObject<HTMLIFrameElement | null>,
  mediaRef: React.MutableRefObject<HTMLVideoElement | HTMLAudioElement | null>,
  iframeTitle: string,
): React.ReactNode {
  switch (artifact.kind) {
    case 'static':
    case 'pdf':
      return (
        <iframe
          key={iframeKey}
          ref={iframeRef}
          src={url}
          className="w-full h-full border-0 bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
          title={iframeTitle}
        />
      );
    case 'video':
      return (
        <div className="w-full h-full bg-black flex items-center justify-center">
          <video
            key={iframeKey}
            ref={mediaRef as React.RefObject<HTMLVideoElement>}
            src={url}
            controls
            className="max-w-full max-h-full"
          />
        </div>
      );
    case 'image':
      return (
        <div className="w-full h-full bg-bg-base flex items-center justify-center overflow-auto">
          <img
            key={iframeKey}
            src={url}
            alt={artifact.relativePath}
            className="max-w-full max-h-full object-contain"
          />
        </div>
      );
    case 'audio':
      return (
        <div className="w-full h-full bg-bg-base flex items-center justify-center p-8">
          <audio
            key={iframeKey}
            ref={mediaRef as React.RefObject<HTMLAudioElement>}
            src={url}
            controls
            className="w-full max-w-md"
          />
        </div>
      );
  }
}
