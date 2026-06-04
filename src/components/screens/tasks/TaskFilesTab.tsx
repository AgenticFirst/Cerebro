import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ChevronRight,
  ChevronDown,
  FileText,
  Folder,
  FolderOpen,
  RefreshCw,
} from 'lucide-react';
import clsx from 'clsx';
import { flattenFiles } from '../../../utils/workspace-tree';
import type { WorkspaceFileNode } from '../../../types/ipc';
import { hasTextExt, kindForFile, treeFingerprint } from './file-preview-helpers';
import { formatBytes } from '../files/utils';

interface TaskFilesTabProps {
  // On-disk workspace folder name (task.workspace_dir, or task.id for legacy
  // pre-migration rows). Used to call task-workspace IPC and compose the
  // cerebro-workspace:// preview URL.
  taskId: string;
  /** When set, the file listing comes from this external project folder instead
   * of the hidden per-task workspace dir. */
  projectPath: string | null;
  /** Pass through to poll while the task is in flight. Stops polling when idle
   * so we don't redundantly re-scan a settled workspace. */
  isRunning?: boolean;
}

interface InlineTextBody {
  path: string;
  body: string;
}

export default function TaskFilesTab({
  taskId,
  projectPath,
  isRunning = false,
}: TaskFilesTabProps) {
  const { t } = useTranslation();

  const [tree, setTree] = useState<WorkspaceFileNode[]>([]);
  const [probeKey, setProbeKey] = useState(0);
  const [selected, setSelected] = useState<WorkspaceFileNode | null>(null);
  const [textBody, setTextBody] = useState<InlineTextBody | null>(null);
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  const treeFpRef = useRef('');

  // Fingerprint guard keeps `tree` referentially stable when the poll returns
  // identical data — without it the file tree would re-render every 3 s and
  // collapse the user's open folders.
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        const next = await window.cerebro.taskTerminal.listFiles(taskId, projectPath ?? undefined);
        if (cancelled) return;
        const fp = treeFingerprint(next);
        if (fp !== treeFpRef.current) {
          treeFpRef.current = fp;
          setTree(next);
        }
      } catch {
        if (!cancelled) {
          setTree([]);
          treeFpRef.current = '';
        }
      }
    };
    probe();
    if (isRunning) {
      const id = setInterval(probe, 3000);
      return () => {
        cancelled = true;
        clearInterval(id);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [taskId, projectPath, isRunning, probeKey]);

  const flatFiles = useMemo(() => {
    const flat = flattenFiles(tree);
    flat.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    return flat;
  }, [tree]);

  const recentFiles = useMemo(() => flatFiles.slice(0, 5), [flatFiles]);

  useEffect(() => {
    if (!selected || !hasTextExt(selected.name)) {
      setTextBody(null);
      return;
    }
    if (textBody?.path === selected.path) return;
    let cancelled = false;
    (async () => {
      try {
        const body = await window.cerebro.taskTerminal.readFile(taskId, selected.path);
        if (!cancelled) setTextBody({ path: selected.path, body: body ?? '' });
      } catch {
        if (!cancelled) setTextBody({ path: selected.path, body: '' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, taskId, textBody?.path]);

  const handleReveal = useCallback(async () => {
    try {
      const wsPath = projectPath
        ? projectPath
        : await window.cerebro.taskTerminal.getWorkspacePath(taskId);
      await window.cerebro.sandbox.revealWorkspace(wsPath);
    } catch {
      /* best-effort */
    }
  }, [projectPath, taskId]);

  const toggleFolder = useCallback((path: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handlePickFile = useCallback((file: WorkspaceFileNode) => {
    setSelected(file);
  }, []);

  const handleBack = useCallback(() => {
    setSelected(null);
    setTextBody(null);
  }, []);

  const toolbar = (
    <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border-subtle bg-bg-surface">
      {selected ? (
        <button
          onClick={handleBack}
          className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          title={t('tasks.filesBack')}
          aria-label={t('tasks.filesBack')}
        >
          <ArrowLeft size={14} />
        </button>
      ) : null}
      <Folder size={14} className="text-text-tertiary flex-shrink-0" />
      <span className="text-xs text-text-tertiary truncate flex-1">
        {selected ? (
          <span className="font-mono">{selected.path}</span>
        ) : (
          t('tasks.filesCount', { count: flatFiles.length })
        )}
      </span>
      <button
        onClick={() => setProbeKey((k) => k + 1)}
        className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
        title={t('tasks.previewRefresh')}
        aria-label={t('tasks.previewRefresh')}
      >
        <RefreshCw size={14} />
      </button>
      <button
        onClick={handleReveal}
        className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
        title={t('tasks.filesRevealWorkspace')}
        aria-label={t('tasks.filesRevealWorkspace')}
      >
        <FolderOpen size={14} />
      </button>
    </div>
  );

  // ── Selected-file viewer ──
  if (selected) {
    const kind = kindForFile(selected.name);
    const fileUrl = `cerebro-workspace://${taskId}/${selected.path}`;
    let body: React.ReactNode;
    if (kind === 'text') {
      body = (
        <pre className="text-xs font-mono text-text-primary whitespace-pre p-4 leading-relaxed">
          {textBody?.path === selected.path
            ? textBody.body || t('tasks.previewEmptyFile')
            : t('tasks.previewLoadingFile')}
        </pre>
      );
    } else if (kind === 'image') {
      body = (
        <div className="w-full h-full flex items-center justify-center overflow-auto">
          <img src={fileUrl} alt={selected.name} className="max-w-full max-h-full object-contain" />
        </div>
      );
    } else if (kind === 'video') {
      body = (
        <div className="w-full h-full bg-black flex items-center justify-center">
          <video src={fileUrl} controls className="max-w-full max-h-full" />
        </div>
      );
    } else if (kind === 'audio') {
      body = (
        <div className="w-full h-full flex items-center justify-center p-8">
          <audio src={fileUrl} controls className="w-full max-w-md" />
        </div>
      );
    } else if (kind === 'pdf' || kind === 'static') {
      body = (
        <iframe
          src={fileUrl}
          className="w-full h-full border-0"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
          title={selected.name}
        />
      );
    } else {
      body = (
        <div className="w-full h-full flex flex-col items-center justify-center gap-3 p-8 text-center text-text-tertiary">
          <FileText size={32} className="opacity-30" />
          <p className="text-xs max-w-md">{t('tasks.filesPreviewUnavailable')}</p>
          <button
            onClick={handleReveal}
            className="px-3 py-1.5 rounded-md bg-bg-elevated border border-border-subtle text-text-secondary hover:text-text-primary text-xs cursor-pointer transition-colors"
          >
            {t('tasks.filesRevealWorkspace')}
          </button>
        </div>
      );
    }
    return (
      <div className="flex flex-col h-full bg-bg-base">
        {toolbar}
        <div className="flex-1 min-h-0 overflow-auto bg-bg-base">{body}</div>
      </div>
    );
  }

  // ── List view: Recent + grouped tree ──
  if (flatFiles.length === 0) {
    return (
      <div className="flex flex-col h-full bg-bg-base">
        {toolbar}
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 text-text-tertiary p-10 text-center">
          <Folder size={36} className="opacity-30" />
          <p className="text-sm font-medium">{t('tasks.filesEmpty')}</p>
          <p className="text-xs max-w-md">{t('tasks.filesEmptyHint')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-bg-base">
      {toolbar}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-5">
        {recentFiles.length > 0 && (
          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary mb-2">
              {t('tasks.filesRecent')}
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {recentFiles.map((f) => {
                const clickable = !!kindForFile(f.name);
                return (
                  <button
                    key={f.path}
                    onClick={() => clickable && handlePickFile(f)}
                    disabled={!clickable}
                    className={clsx(
                      'inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-bg-elevated border border-border-subtle text-text-secondary font-mono text-xs max-w-[220px] transition-colors',
                      clickable
                        ? 'hover:text-text-primary hover:border-border-default cursor-pointer'
                        : 'cursor-default opacity-70',
                    )}
                    title={f.path}
                  >
                    <FileText size={10} className="flex-shrink-0" />
                    <span className="truncate">{f.name}</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        <section>
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary mb-2">
            {t('tasks.filesAll')}
          </h3>
          <FileTree
            nodes={tree}
            openFolders={openFolders}
            onToggleFolder={toggleFolder}
            onPickFile={handlePickFile}
            t={t}
          />
        </section>
      </div>
    </div>
  );
}

interface FileTreeProps {
  nodes: WorkspaceFileNode[];
  openFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  onPickFile: (file: WorkspaceFileNode) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
  depth?: number;
}

function FileTree({ nodes, openFolders, onToggleFolder, onPickFile, t, depth = 0 }: FileTreeProps) {
  // Folders first, then files; both alphabetically. Matches the order the
  // backend already returns, but enforced locally so we stay correct even if
  // an external project folder serves them differently.
  const sorted = useMemo(() => {
    return [...nodes].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [nodes]);

  return (
    <ul className="space-y-0.5">
      {sorted.map((node) => {
        if (node.type === 'dir') {
          const isOpen = openFolders.has(node.path);
          return (
            <li key={node.path}>
              <button
                type="button"
                onClick={() => onToggleFolder(node.path)}
                className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs text-left text-text-secondary hover:bg-bg-hover cursor-pointer transition-colors"
                style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
              >
                {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <Folder size={12} className="opacity-60" />
                <span className="truncate font-mono">{node.name}</span>
              </button>
              {isOpen && node.children && node.children.length > 0 && (
                <FileTree
                  nodes={node.children as WorkspaceFileNode[]}
                  openFolders={openFolders}
                  onToggleFolder={onToggleFolder}
                  onPickFile={onPickFile}
                  t={t}
                  depth={depth + 1}
                />
              )}
            </li>
          );
        }

        const clickable = !!kindForFile(node.name);
        return (
          <li key={node.path}>
            <button
              type="button"
              onClick={() => clickable && onPickFile(node)}
              disabled={!clickable}
              className={clsx(
                'w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs text-left transition-colors',
                clickable
                  ? 'text-text-primary hover:bg-bg-hover cursor-pointer'
                  : 'text-text-tertiary cursor-default',
              )}
              style={{ paddingLeft: `${0.5 + depth * 0.75 + 0.75}rem` }}
              title={clickable ? node.path : undefined}
            >
              <FileText size={12} className="flex-shrink-0 opacity-60" />
              <span className="truncate font-mono flex-1">{node.name}</span>
              <span className="text-[10px] text-text-tertiary flex-shrink-0">
                {node.size ? formatBytes(node.size) : ''}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
