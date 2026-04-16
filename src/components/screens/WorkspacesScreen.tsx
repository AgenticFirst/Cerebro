import { useEffect, useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { FolderOpen, ExternalLink, RefreshCw, ArrowLeftRight } from 'lucide-react';
import { useTasks, type Task, type TaskColumn } from '../../context/TaskContext';
import { useExperts } from '../../context/ExpertContext';
import type { WorkspaceFileNode } from '../../types/ipc';
import FileTree from './workspaces/FileTree';

type GroupBy = 'task' | 'expert';

const COLUMN_COLORS: Record<TaskColumn, string> = {
  backlog: 'bg-zinc-600/30 text-zinc-400',
  in_progress: 'bg-cyan-500/15 text-cyan-400',
  to_review: 'bg-amber-500/15 text-amber-400',
  completed: 'bg-emerald-500/15 text-emerald-400',
  error: 'bg-red-500/15 text-red-400',
};

const COLUMN_LABEL_KEYS: Record<TaskColumn, string> = {
  backlog: 'tasks.column_backlog',
  in_progress: 'tasks.column_in_progress',
  to_review: 'tasks.column_to_review',
  completed: 'tasks.column_completed',
  error: 'tasks.column_error',
};

// File extensions that render as text in the preview pane
const TEXT_EXTENSIONS = new Set([
  'md', 'txt', 'json', 'yaml', 'yml', 'toml', 'xml', 'csv',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp',
  'css', 'scss', 'sass', 'less',
  'sh', 'bash', 'zsh', 'fish',
  'env', 'gitignore', 'dockerfile',
]);

const HTML_EXTENSIONS = new Set(['html', 'htm']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico']);

function getExtension(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

export default function WorkspacesScreen() {
  const { t } = useTranslation();
  const { tasks, loadTasks } = useTasks();
  const { experts } = useExperts();

  const [groupBy, setGroupBy] = useState<GroupBy>('task');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [fileTree, setFileTree] = useState<WorkspaceFileNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<WorkspaceFileNode | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [workspacePath, setWorkspacePath] = useState<string>('');

  // Only tasks that have been started (have a run_id) have a workspace
  const tasksWithWorkspace = useMemo(
    () => tasks.filter((t) => !!t.run_id).sort((a, b) => {
      const aDate = a.updated_at || a.created_at;
      const bDate = b.updated_at || b.created_at;
      return bDate.localeCompare(aDate);
    }),
    [tasks],
  );

  const selectedTask = useMemo(
    () => tasksWithWorkspace.find((t) => t.id === selectedTaskId) ?? null,
    [tasksWithWorkspace, selectedTaskId],
  );

  // Group by expert
  const groupedByExpert = useMemo(() => {
    const groups = new Map<string | null, Task[]>();
    for (const task of tasksWithWorkspace) {
      const key = task.expert_id || null;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(task);
    }
    return groups;
  }, [tasksWithWorkspace]);

  const expertName = useCallback(
    (expertId: string | null): string => {
      if (!expertId) return t('tasks.drawerUnassigned');
      const exp = experts.find((e) => e.id === expertId);
      return exp?.name ?? t('tasks.drawerUnassigned');
    },
    [experts, t],
  );

  // Load file tree when task changes
  const loadFileTree = useCallback(async (taskId: string) => {
    try {
      const [tree, path] = await Promise.all([
        window.cerebro.taskTerminal.listFiles(taskId),
        window.cerebro.taskTerminal.getWorkspacePath(taskId),
      ]);
      setFileTree(tree);
      setWorkspacePath(path);
    } catch (err) {
      console.error('[WorkspacesScreen] Failed to load file tree:', err);
      setFileTree([]);
      setWorkspacePath('');
    }
  }, []);

  useEffect(() => {
    if (selectedTaskId) {
      loadFileTree(selectedTaskId);
      setSelectedFile(null);
      setFileContent(null);
    } else {
      setFileTree([]);
      setSelectedFile(null);
      setFileContent(null);
    }
  }, [selectedTaskId, loadFileTree]);

  // Load file content when a file is selected
  useEffect(() => {
    if (!selectedFile || !selectedTaskId) {
      setFileContent(null);
      return;
    }
    const ext = getExtension(selectedFile.name);
    // HTML renders as iframe, images as <img> — no need to read content
    if (HTML_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext)) return;
    // Read text content
    window.cerebro.taskTerminal.readFile(selectedTaskId, selectedFile.path)
      .then((content) => setFileContent(content))
      .catch((err) => {
        console.error('[WorkspacesScreen] Failed to read file:', err);
        setFileContent(null);
      });
  }, [selectedFile, selectedTaskId]);

  const handleRevealInFinder = useCallback(() => {
    if (workspacePath) {
      window.cerebro.shell.openPath(workspacePath);
    }
  }, [workspacePath]);

  const handleRefreshTree = useCallback(() => {
    if (selectedTaskId) loadFileTree(selectedTaskId);
  }, [selectedTaskId, loadFileTree]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  const renderTaskListItem = (task: Task) => {
    const isSelected = selectedTaskId === task.id;
    return (
      <button
        key={task.id}
        onClick={() => setSelectedTaskId(task.id)}
        className={clsx(
          'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors cursor-pointer',
          isSelected ? 'bg-accent/10 border border-accent/30' : 'hover:bg-bg-hover border border-transparent',
        )}
      >
        <div className="flex-1 min-w-0">
          <div className="text-sm text-text-primary truncate">{task.title}</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span
              className={clsx(
                'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                COLUMN_COLORS[task.column],
              )}
            >
              {t(COLUMN_LABEL_KEYS[task.column])}
            </span>
            {groupBy === 'task' && task.expert_id && (
              <span className="text-[10px] text-text-tertiary truncate">
                {expertName(task.expert_id)}
              </span>
            )}
          </div>
        </div>
      </button>
    );
  };

  return (
    <div className="flex-1 flex min-h-0 relative">
      {/* Left: Task list */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <div className="px-5 pt-3 pb-2 flex items-center justify-between flex-shrink-0">
          <h1 className="text-base font-semibold text-text-primary">{t('workspaces.title')}</h1>
          <div className="flex items-center gap-0.5 bg-bg-surface rounded-lg p-0.5 border border-border-subtle">
            <button
              onClick={() => setGroupBy('task')}
              className={clsx(
                'px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors cursor-pointer',
                groupBy === 'task'
                  ? 'bg-accent/15 text-accent'
                  : 'text-text-tertiary hover:text-text-primary',
              )}
            >
              {t('workspaces.byTask')}
            </button>
            <button
              onClick={() => setGroupBy('expert')}
              className={clsx(
                'px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors cursor-pointer',
                groupBy === 'expert'
                  ? 'bg-accent/15 text-accent'
                  : 'text-text-tertiary hover:text-text-primary',
              )}
            >
              {t('workspaces.byExpert')}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {tasksWithWorkspace.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-text-tertiary">
              <FolderOpen size={36} className="opacity-30" />
              <p className="text-sm">{t('workspaces.empty')}</p>
              <p className="text-xs max-w-sm text-center">{t('workspaces.emptyHint')}</p>
            </div>
          ) : groupBy === 'task' ? (
            <div className="space-y-1">
              {tasksWithWorkspace.map(renderTaskListItem)}
            </div>
          ) : (
            <div className="space-y-4">
              {Array.from(groupedByExpert.entries()).map(([expertId, expertTasks]) => (
                <div key={expertId ?? 'unassigned'}>
                  <div className="text-[10px] uppercase tracking-wider text-text-tertiary font-semibold px-2 pb-1.5">
                    {expertName(expertId)}{' '}
                    <span className="opacity-60">({expertTasks.length})</span>
                  </div>
                  <div className="space-y-1">
                    {expertTasks.map(renderTaskListItem)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right: Workspace detail panel */}
      {selectedTask && (
        <div className="w-[460px] flex-shrink-0 border-l border-border-subtle flex flex-col min-h-0 bg-bg-base animate-slide-in-right">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle flex-shrink-0">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-text-primary truncate">{selectedTask.title}</div>
              <div className="text-[10px] text-text-tertiary truncate font-mono">{workspacePath}</div>
            </div>
            <button
              onClick={handleRefreshTree}
              className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
              title={t('workspaces.refresh')}
            >
              <RefreshCw size={14} />
            </button>
            <button
              onClick={handleRevealInFinder}
              className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
              title={t('workspaces.openInFinder')}
            >
              <ExternalLink size={14} />
            </button>
            <button
              onClick={() => setSelectedTaskId(null)}
              className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
            >
              <ArrowLeftRight size={14} />
            </button>
          </div>

          {/* File tree */}
          <div className="max-h-[40%] overflow-y-auto border-b border-border-subtle">
            {fileTree.length === 0 ? (
              <div className="p-6 text-center text-text-tertiary text-xs">
                {t('workspaces.emptyFiles')}
              </div>
            ) : (
              <FileTree
                nodes={fileTree}
                selectedPath={selectedFile?.path ?? null}
                onSelect={setSelectedFile}
              />
            )}
          </div>

          {/* File preview */}
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
            {selectedFile ? (
              <FilePreview
                taskId={selectedTask.id}
                file={selectedFile}
                content={fileContent}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center text-text-tertiary text-xs p-6">
                {t('workspaces.selectFileHint')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FilePreview({
  taskId,
  file,
  content,
}: {
  taskId: string;
  file: WorkspaceFileNode;
  content: string | null;
}) {
  const ext = getExtension(file.name);
  const url = `cerebro-workspace://${taskId}/${file.path}`;

  if (HTML_EXTENSIONS.has(ext)) {
    return (
      <iframe
        src={url}
        className="w-full h-full border-0 bg-white"
        sandbox="allow-scripts allow-same-origin allow-forms"
        title={file.name}
      />
    );
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return (
      <div className="flex-1 flex items-center justify-center overflow-auto bg-black/20 p-4">
        <img src={url} alt={file.name} className="max-w-full max-h-full object-contain" />
      </div>
    );
  }
  if (TEXT_EXTENSIONS.has(ext) || ext === '') {
    return (
      <pre className="flex-1 overflow-auto p-3 text-[11px] text-text-secondary font-mono leading-relaxed whitespace-pre-wrap bg-bg-surface/50">
        {content ?? '(empty)'}
      </pre>
    );
  }
  return (
    <div className="flex-1 flex items-center justify-center text-text-tertiary text-xs">
      Binary file ({ext || 'unknown type'})
    </div>
  );
}
