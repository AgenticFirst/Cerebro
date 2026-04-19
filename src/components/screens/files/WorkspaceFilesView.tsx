import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { ExternalLink, FolderOpen, RefreshCw, Save } from 'lucide-react';
import { useTasks, type Task, type TaskColumn } from '../../../context/TaskContext';
import { useFiles } from '../../../context/FilesContext';
import type { WorkspaceFileNode } from '../../../types/ipc';
import FileTree from '../workspaces/FileTree';
import MoveCopyDialog from './MoveCopyDialog';

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

export default function WorkspaceFilesView() {
  const { t } = useTranslation();
  const { tasks, loadTasks } = useTasks();
  const { saveExternalToFiles } = useFiles();

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [fileTree, setFileTree] = useState<WorkspaceFileNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<WorkspaceFileNode | null>(null);
  const [workspacePath, setWorkspacePath] = useState<string>('');
  const [showSaveDialog, setShowSaveDialog] = useState(false);

  useEffect(() => { loadTasks(); }, [loadTasks]);

  const tasksWithWorkspace = useMemo<Task[]>(
    () => tasks.filter((task) => !!task.run_id).sort((a, b) => {
      const aDate = a.updated_at || a.created_at;
      const bDate = b.updated_at || b.created_at;
      return bDate.localeCompare(aDate);
    }),
    [tasks],
  );

  const selectedTask = useMemo(
    () => tasksWithWorkspace.find((task) => task.id === selectedTaskId) ?? null,
    [tasksWithWorkspace, selectedTaskId],
  );

  const loadFileTree = useCallback(async (taskId: string) => {
    try {
      const [tree, path] = await Promise.all([
        window.cerebro.taskTerminal.listFiles(taskId),
        window.cerebro.taskTerminal.getWorkspacePath(taskId),
      ]);
      setFileTree(tree);
      setWorkspacePath(path);
    } catch (err) {
      console.error('[WorkspaceFilesView] Failed to load file tree:', err);
      setFileTree([]);
      setWorkspacePath('');
    }
  }, []);

  useEffect(() => {
    if (selectedTaskId) {
      loadFileTree(selectedTaskId);
      setSelectedFile(null);
    } else {
      setFileTree([]);
      setSelectedFile(null);
    }
  }, [selectedTaskId, loadFileTree]);

  const handleSaveSelected = async (bucketId: string) => {
    if (!selectedFile || !selectedTaskId || !workspacePath) return;
    const sourcePath = `${workspacePath}/${selectedFile.path}`;
    await saveExternalToFiles({
      sourcePath,
      source: 'workspace-save',
      sourceTaskId: selectedTaskId,
      bucketId,
      displayName: selectedFile.name,
    });
  };

  return (
    <div className="flex-1 flex min-h-0">
      {/* Task list */}
      <div className="w-[300px] flex-shrink-0 border-r border-border-subtle flex flex-col min-h-0 overflow-hidden">
        <div className="app-drag-region h-11 flex-shrink-0" />
        <div className="flex items-center px-4 border-b border-border-subtle flex-shrink-0 h-[60px]">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-text-primary truncate">
              {t('files.sourceWorkspaces')}
            </div>
            <div className="text-[10px] text-text-tertiary truncate">
              {t('files.workspacesTaskCount', { count: tasksWithWorkspace.length, defaultValue: '{{count}} task workspaces' })}
            </div>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {tasksWithWorkspace.length === 0 ? (
            <div className="h-full min-h-[240px] flex flex-col items-center justify-center gap-3 text-text-tertiary p-6">
              <FolderOpen size={28} className="opacity-30" />
              <p className="text-xs text-center">{t('files.emptyWorkspacesHint')}</p>
            </div>
          ) : (
            tasksWithWorkspace.map((task) => {
              const isSelected = selectedTaskId === task.id;
              return (
                <button
                  key={task.id}
                  onClick={() => setSelectedTaskId(task.id)}
                  className={clsx(
                    'w-full flex flex-col items-start gap-1 px-3 py-2 rounded-lg text-left transition-colors cursor-pointer border',
                    isSelected
                      ? 'bg-accent/10 border-accent/30'
                      : 'border-transparent hover:bg-bg-hover',
                  )}
                >
                  <span className="text-sm text-text-primary truncate w-full">{task.title}</span>
                  <span
                    className={clsx(
                      'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                      COLUMN_COLORS[task.column],
                    )}
                  >
                    {t(COLUMN_LABEL_KEYS[task.column])}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Detail panel */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <div className="app-drag-region h-11 flex-shrink-0" />
        {!selectedTask ? (
          <>
            <div className="flex items-center px-4 border-b border-border-subtle flex-shrink-0 h-[60px]" />
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-text-tertiary p-6">
              <FolderOpen size={36} className="opacity-30" />
              <p className="text-sm">{t('files.workspacesPickTask')}</p>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 px-4 border-b border-border-subtle flex-shrink-0 h-[60px]">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-text-primary truncate">{selectedTask.title}</div>
                <div className="text-[10px] text-text-tertiary truncate font-mono">{workspacePath}</div>
              </div>
              <button
                onClick={() => loadFileTree(selectedTask.id)}
                title={t('files.refresh')}
                className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover cursor-pointer"
              >
                <RefreshCw size={14} />
              </button>
              <button
                onClick={() => workspacePath && window.cerebro.shell.openPath(workspacePath)}
                title={t('files.openInFinder')}
                className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover cursor-pointer"
              >
                <ExternalLink size={14} />
              </button>
            </div>

            <div className="flex-1 flex min-h-0">
              {/* Tree */}
              <div className="w-[280px] flex-shrink-0 border-r border-border-subtle overflow-y-auto">
                {fileTree.length === 0 ? (
                  <div className="p-6 text-center text-text-tertiary text-xs">
                    {t('files.workspacesEmptyFiles')}
                  </div>
                ) : (
                  <FileTree
                    nodes={fileTree}
                    selectedPath={selectedFile?.path ?? null}
                    onSelect={setSelectedFile}
                  />
                )}
              </div>

              {/* Action panel */}
              <div className="flex-1 min-h-0 overflow-auto p-4">
                {selectedFile ? (
                  <div className="space-y-3">
                    <div>
                      <div className="text-xs text-text-tertiary uppercase tracking-wider mb-1">
                        {t('files.actionPreview')}
                      </div>
                      <div className="text-sm text-text-primary">{selectedFile.name}</div>
                      <div className="text-[10px] text-text-tertiary font-mono mt-0.5">
                        {selectedFile.path}
                      </div>
                    </div>
                    <button
                      onClick={() => setShowSaveDialog(true)}
                      className="px-3 py-1.5 rounded-md text-xs bg-accent/10 text-accent border border-accent/20 hover:bg-accent/20 cursor-pointer flex items-center gap-1.5"
                    >
                      <Save size={12} /> {t('files.workspacesSaveAction')}
                    </button>
                  </div>
                ) : (
                  <div className="h-full flex items-center justify-center text-text-tertiary text-xs">
                    {t('files.selectFileHint')}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {showSaveDialog && selectedFile && (
        <MoveCopyDialog
          mode="copy"
          count={1}
          onClose={() => setShowSaveDialog(false)}
          onConfirm={async (bucketId) => { await handleSaveSelected(bucketId); }}
        />
      )}
    </div>
  );
}
