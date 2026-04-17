import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, ExternalLink, Eye, FileText, FolderOpen, ArrowLeft } from 'lucide-react';
import clsx from 'clsx';
import { flattenFiles } from '../../../utils/workspace-tree';
import type { WorkspaceFileNode } from '../../../types/ipc';

interface LivePreviewProps {
  taskId: string;
  runId: string | null;
  /** Whether the task is actively running (in_progress with a live agent). */
  isRunning?: boolean;
  /** External project folder (if the task has one). Used when probing for files. */
  projectPath?: string | null;
  className?: string;
}

type PreviewKind = 'static' | 'dev_server' | 'video' | 'image' | 'pdf' | 'audio' | 'text';

interface ArtifactPreview {
  kind: PreviewKind;
  /** Workspace-relative file path. Empty string for dev_server previews. */
  relativePath: string;
  /** Last-modified time of the artifact. Used to drive iframe reloads only
   * when the underlying file actually changes (prevents the 3s flicker that
   * a blind auto-refresh interval caused). */
  mtime?: number;
}

const VIDEO_EXTS = ['.mp4', '.webm', '.mov'];
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif'];
const AUDIO_EXTS = ['.mp3', '.wav', '.ogg'];
const PDF_EXTS = ['.pdf'];
/** Text extensions we can render inline as source code. Kept broad — most
 * source/config/doc formats the agent is likely to produce should be
 * clickable from the fallback file list. */
const TEXT_EXTS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini',
  '.md', '.mdx', '.txt', '.log',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.h', '.cpp', '.hpp', '.cc',
  '.sh', '.bash', '.zsh', '.fish',
  '.html', '.htm', '.xml', '.css', '.scss', '.less',
  '.env', '.env.example',
  '.gitignore', '.dockerignore',
  '.dockerfile', '.editorconfig',
];

function hasTextExt(name: string): boolean {
  const lower = name.toLowerCase();
  if (TEXT_EXTS.some((e) => lower.endsWith(e))) return true;
  // Common extensionless config files.
  if (['dockerfile', 'makefile', 'readme', 'license', 'procfile'].includes(lower)) return true;
  return false;
}

/** Extension-based kind lookup. Media/iframe-renderable kinds take priority;
 * text falls through as the last resort. Returns null only for binary formats
 * we don't know how to render at all. */
function kindForFile(name: string): PreviewKind | null {
  const lower = name.toLowerCase();
  if (lower === 'index.html') return 'static';
  if (VIDEO_EXTS.some((e) => lower.endsWith(e))) return 'video';
  if (IMAGE_EXTS.some((e) => lower.endsWith(e))) return 'image';
  if (PDF_EXTS.some((e) => lower.endsWith(e))) return 'pdf';
  if (AUDIO_EXTS.some((e) => lower.endsWith(e))) return 'audio';
  if (hasTextExt(name)) return 'text';
  return null;
}

const PREVIEW_PRIORITY: PreviewKind[] = ['static', 'video', 'pdf', 'image', 'audio'];

/** Pick the best artifact to auto-preview — priority-ordered, shallowest
 * first, then most recent mtime. Text files are deliberately excluded: when
 * only source files exist we prefer the file-browser fallback so the user
 * sees the whole output, not an arbitrary package.json as the "main" view. */
function pickArtifact(tree: WorkspaceFileNode[]): ArtifactPreview | null {
  const files = flattenFiles(tree);
  const candidates: Array<{ kind: PreviewKind; relativePath: string; depth: number; mtime: number }> = [];
  for (const f of files) {
    const kind = kindForFile(f.name);
    if (!kind || kind === 'text') continue;
    candidates.push({
      kind,
      relativePath: f.path,
      depth: (f.path.match(/[\\/]/g) ?? []).length,
      mtime: f.mtime ?? 0,
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const pa = PREVIEW_PRIORITY.indexOf(a.kind);
    const pb = PREVIEW_PRIORITY.indexOf(b.kind);
    if (pa !== pb) return pa - pb;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return b.mtime - a.mtime;
  });
  return { kind: candidates[0].kind, relativePath: candidates[0].relativePath, mtime: candidates[0].mtime };
}

/** Stable fingerprint for a workspace tree. Used so we only replace the
 * `tree` state when something actually changed — keeps React from
 * re-rendering descendants (the file browser, in particular) on every
 * 3-second polling tick. */
function treeFingerprint(tree: WorkspaceFileNode[]): string {
  const out: string[] = [];
  const walk = (nodes: WorkspaceFileNode[]) => {
    for (const n of nodes) {
      out.push(`${n.path}:${n.size ?? 0}:${n.mtime ?? 0}`);
      if (n.children) walk(n.children);
    }
  };
  walk(tree);
  return out.join('|');
}

function formatBytes(n: number | undefined): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Live preview of the agent's workspace output.
 *
 * Strategy, in order:
 *   1. Dev-server URL detected in agent text → iframe at that URL.
 *   2. User-selected file from the fallback file browser → render per its kind.
 *   3. Auto-picked renderable artifact (index.html, .mp4, .pdf, image, audio).
 *   4. Fallback: compact file browser of workspace contents, so the user can
 *      see what the agent produced and pick a file to preview.
 *   5. True empty state only when the workspace has zero files.
 */
export default function LivePreview({ taskId, runId, isRunning = false, projectPath, className }: LivePreviewProps) {
  const { t } = useTranslation();

  // The cerebro-workspace:// protocol only serves the internal per-task
  // workspace dir; external project folders can only preview via dev-server URL.
  const isExternalProject = !!projectPath;

  const [tree, setTree] = useState<WorkspaceFileNode[]>([]);
  const [autoArtifact, setAutoArtifact] = useState<ArtifactPreview | null>(null);
  const [userPickedArtifact, setUserPickedArtifact] = useState<ArtifactPreview | null>(null);
  const [devServerUrl, setDevServerUrl] = useState<string | null>(null);
  const [probeKey, setProbeKey] = useState(0);
  const [iframeKey, setIframeKey] = useState(0);
  const [textContent, setTextContent] = useState<{ path: string; body: string } | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);

  // Workspace probe — fires on mount, when running (every 3s), and whenever
  // the user clicks Refresh (probeKey bump).
  const treeFpRef = useRef<string>('');
  useEffect(() => {
    if (isExternalProject) {
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
        // Skip the state write (and subsequent re-render) when nothing
        // changed. Without this the 3-second poll was minting a new `tree`
        // array on every tick and the file browser flickered.
        const fp = treeFingerprint(next);
        if (fp !== treeFpRef.current) {
          treeFpRef.current = fp;
          setTree(next);
        }
        const picked = pickArtifact(next);
        setAutoArtifact((prev) => {
          // Compare by kind+path+mtime so the reference stays stable while
          // the file is unchanged; only a real content change (mtime bump)
          // produces a new reference and drives the reload effect below.
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
  }, [taskId, isRunning, isExternalProject, probeKey]);

  // Dev-server URL detection from streaming agent text.
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
      /Local:\s+(https?:\/\/[^\s]+)/,                              // Vite
      /ready\s+-\s+started\s+server\s+on\s+(https?:\/\/[^\s]+)/i,  // Next.js
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

  // Auto-reload the preview when the underlying file changes on disk — but
  // NOT on every poll tick. The probe feeds the artifact's mtime into state;
  // this effect bumps iframeKey only when the mtime actually moves forward,
  // so a stable artifact renders once and stays rendered (no 3s flicker).
  const mtimeSeenRef = useRef<number | undefined>(undefined);
  const pathSeenRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (devServerUrl) return;
    const current = userPickedArtifact ?? autoArtifact;
    if (!current) {
      mtimeSeenRef.current = undefined;
      pathSeenRef.current = undefined;
      return;
    }
    const pathChanged = pathSeenRef.current !== current.relativePath;
    const mtimeChanged = mtimeSeenRef.current !== undefined
      && current.mtime !== undefined
      && mtimeSeenRef.current !== current.mtime;
    if (pathChanged) {
      pathSeenRef.current = current.relativePath;
      mtimeSeenRef.current = current.mtime;
      // First time seeing this artifact — no reload needed; the render
      // already shows it fresh.
      return;
    }
    if (mtimeChanged) {
      mtimeSeenRef.current = current.mtime;
      setIframeKey((k) => k + 1);
    }
  }, [devServerUrl, userPickedArtifact, autoArtifact]);

  // Flat file list for the fallback browser.
  const flatFiles = useMemo(() => {
    const flat = flattenFiles(tree);
    flat.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    return flat;
  }, [tree]);

  // User's explicit pick (if any) wins over auto-selection.
  const artifact = userPickedArtifact ?? autoArtifact;
  const source: PreviewKind | null = devServerUrl ? 'dev_server' : (artifact?.kind ?? null);
  const previewUrl = devServerUrl
    ? devServerUrl
    : artifact
      ? `cerebro-workspace://${taskId}/${artifact.relativePath}`
      : '';

  const handleRefresh = useCallback(() => {
    // Re-probe the workspace so new files/mtimes are picked up, then reload
    // the current preview element so in-place edits show immediately.
    setProbeKey((k) => k + 1);
    setIframeKey((k) => k + 1);
    if (source === 'dev_server' && iframeRef.current) {
      iframeRef.current.src = previewUrl;
    }
    if ((source === 'video' || source === 'audio') && mediaRef.current) {
      mediaRef.current.load();
    }
  }, [source, previewUrl]);

  const handleOpenExternal = useCallback(async () => {
    // Dev-server URLs are normal http — open directly.
    if (source === 'dev_server') {
      window.open(previewUrl, '_blank');
      return;
    }
    // Workspace files live under a custom protocol that an external browser
    // can't resolve. Reveal the workspace directory in the OS file manager
    // so the user can double-click the artifact themselves.
    try {
      const wsPath = projectPath
        ? projectPath
        : await window.cerebro.taskTerminal.getWorkspacePath(taskId);
      await window.cerebro.sandbox.revealWorkspace(wsPath);
    } catch (err) {
      console.warn('[LivePreview] Failed to reveal workspace:', err);
    }
  }, [source, previewUrl, projectPath, taskId]);

  const handleResetToAutoArtifact = useCallback(() => {
    setDevServerUrl(null);
    setUserPickedArtifact(null);
    hasDetectedRef.current = false;
    setIframeKey((k) => k + 1);
  }, []);

  const handlePickFile = useCallback((file: WorkspaceFileNode) => {
    const kind = kindForFile(file.name);
    if (!kind) return; // non-previewable file — ignore click for now
    setUserPickedArtifact({ kind, relativePath: file.path });
    setTextContent(null); // clear stale text body; reloaded below for 'text'
    setIframeKey((k) => k + 1);
  }, []);

  // Fetch file body whenever the current artifact is a text file. Capped at
  // 1 MB by the backend readFile handler; anything larger returns null.
  useEffect(() => {
    if (source !== 'text' || !artifact) {
      setTextContent(null);
      return;
    }
    if (textContent?.path === artifact.relativePath) return;
    let cancelled = false;
    (async () => {
      try {
        const body = await window.cerebro.taskTerminal.readFile(taskId, artifact.relativePath);
        if (!cancelled) setTextContent({ path: artifact.relativePath, body: body ?? '' });
      } catch {
        if (!cancelled) setTextContent({ path: artifact.relativePath, body: '' });
      }
    })();
    return () => { cancelled = true; };
  }, [source, artifact, taskId, textContent?.path]);

  const badgeLabel =
    source === 'dev_server' ? t('tasks.previewLive')
    : source === 'video' ? t('tasks.previewVideo')
    : source === 'image' ? t('tasks.previewImage')
    : source === 'pdf' ? t('tasks.previewPdf')
    : source === 'audio' ? t('tasks.previewAudio')
    : source === 'text' ? t('tasks.previewCode')
    : t('tasks.previewFiles');

  const badgeClass = source === 'dev_server'
    ? 'bg-emerald-500/15 text-emerald-400'
    : source
      ? 'bg-accent/15 text-accent'
      : 'bg-zinc-600/30 text-zinc-400';

  const showResetBtn = !!(devServerUrl || userPickedArtifact);
  const canRevealExternal = source === 'dev_server' || !isExternalProject;

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
            {previewUrl || (isExternalProject ? t('tasks.previewExternalHint') : t('tasks.previewNoArtifact'))}
          </span>
        </div>
        {showResetBtn && (
          <button
            onClick={handleResetToAutoArtifact}
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
        {canRevealExternal && (
          <button
            onClick={handleOpenExternal}
            className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
            title={source === 'dev_server' ? t('tasks.previewOpenExternal') : t('tasks.previewRevealWorkspace')}
            aria-label={source === 'dev_server' ? t('tasks.previewOpenExternal') : t('tasks.previewRevealWorkspace')}
          >
            {source === 'dev_server' ? <ExternalLink size={14} /> : <FolderOpen size={14} />}
          </button>
        )}
      </div>

      {/* Preview surface */}
      <div className="flex-1 min-h-0 bg-white">
        {source === 'dev_server' || source === 'static' || source === 'pdf' ? (
          <iframe
            key={iframeKey}
            ref={iframeRef}
            src={previewUrl}
            className="w-full h-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
            title="Live preview"
          />
        ) : source === 'video' ? (
          <div className="w-full h-full bg-black flex items-center justify-center">
            <video
              key={iframeKey}
              ref={mediaRef as React.RefObject<HTMLVideoElement>}
              src={previewUrl}
              controls
              className="max-w-full max-h-full"
              title="Live preview"
            />
          </div>
        ) : source === 'image' ? (
          <div className="w-full h-full bg-bg-base flex items-center justify-center overflow-auto">
            <img
              key={iframeKey}
              src={previewUrl}
              alt={artifact?.relativePath ?? 'preview'}
              className="max-w-full max-h-full object-contain"
            />
          </div>
        ) : source === 'audio' ? (
          <div className="w-full h-full bg-bg-base flex items-center justify-center p-8">
            <audio
              key={iframeKey}
              ref={mediaRef as React.RefObject<HTMLAudioElement>}
              src={previewUrl}
              controls
              className="w-full max-w-md"
            />
          </div>
        ) : source === 'text' ? (
          <div
            className="w-full h-full bg-bg-base overflow-auto"
            data-testid="preview-text"
          >
            <pre className="text-xs font-mono text-text-primary whitespace-pre p-4 leading-relaxed">
              {textContent?.path === artifact?.relativePath
                ? (textContent?.body || t('tasks.previewEmptyFile'))
                : t('tasks.previewLoadingFile')}
            </pre>
          </div>
        ) : flatFiles.length > 0 ? (
          // Fallback file browser — workspace has files but nothing directly
          // previewable. Show what was produced so the user isn't staring at
          // "Waiting for files" when the task is clearly done.
          <div
            className="w-full h-full bg-bg-base overflow-auto p-4"
            data-testid="preview-file-browser"
          >
            <p className="text-xs text-text-tertiary mb-3">
              {t('tasks.previewBrowserHint', { count: flatFiles.length })}
            </p>
            <ul className="space-y-0.5">
              {flatFiles.map((f) => {
                const kind = kindForFile(f.name);
                const clickable = !!kind;
                return (
                  <li key={f.path}>
                    <button
                      type="button"
                      onClick={() => handlePickFile(f)}
                      disabled={!clickable}
                      className={clsx(
                        'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-left transition-colors',
                        clickable
                          ? 'text-text-primary hover:bg-bg-hover cursor-pointer'
                          : 'text-text-tertiary cursor-default',
                      )}
                      title={clickable ? t('tasks.previewPickFile') : undefined}
                    >
                      <FileText size={12} className="flex-shrink-0 opacity-60" />
                      <span className="truncate font-mono flex-1">{f.path}</span>
                      <span className="text-[10px] text-text-tertiary flex-shrink-0">
                        {formatBytes(f.size)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <div
            className="w-full h-full bg-bg-base flex flex-col items-center justify-center gap-3 text-text-tertiary p-10 text-center"
            data-testid="preview-empty"
          >
            <Eye size={36} className="opacity-30" />
            <p className="text-sm font-medium">{t('tasks.previewWaiting')}</p>
            <p className="text-xs max-w-md">{t('tasks.previewWaitingHint')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
