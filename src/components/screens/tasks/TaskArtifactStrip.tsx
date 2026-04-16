import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText } from 'lucide-react';
import type { WorkspaceFileNode } from '../../../types/ipc';
import { flattenFiles } from '../../../utils/workspace-tree';

interface TaskArtifactStripProps {
  taskId: string;
  projectPath: string | null;
  runId: string | null;
  onOpenFile?: (relativePath: string) => void;
}

function fingerprint(files: WorkspaceFileNode[]): string {
  return files.map((f) => `${f.path}:${f.mtime ?? 0}`).join('|');
}

export default function TaskArtifactStrip({ taskId, projectPath, runId, onOpenFile }: TaskArtifactStripProps) {
  const { t } = useTranslation();
  const [files, setFiles] = useState<WorkspaceFileNode[]>([]);
  const [total, setTotal] = useState(0);
  const fingerprintRef = useRef('');

  useEffect(() => {
    let cancelled = false;
    const fetchFiles = async () => {
      try {
        const tree = await window.cerebro.taskTerminal.listFiles(
          taskId,
          projectPath ?? undefined,
        );
        if (cancelled) return;
        const flat = flattenFiles(tree);
        flat.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
        const top = flat.slice(0, 3);
        const fp = fingerprint(top);
        if (fp === fingerprintRef.current) {
          setTotal((prev) => (prev === flat.length ? prev : flat.length));
          return;
        }
        fingerprintRef.current = fp;
        setFiles(top);
        setTotal(flat.length);
      } catch {
        if (!cancelled) { setTotal(0); setFiles([]); fingerprintRef.current = ''; }
      }
    };
    fetchFiles();
    if (runId) {
      const id = setInterval(fetchFiles, 10_000);
      return () => { cancelled = true; clearInterval(id); };
    }
    return () => { cancelled = true; };
  }, [taskId, projectPath, runId]);

  if (total === 0) return null;

  return (
    <div className="px-5 py-2 border-b border-border-subtle flex items-center gap-2 text-xs">
      <span className="text-text-tertiary flex-shrink-0">{t('tasks.drawerArtifacts')}</span>
      <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto">
        {files.map((f) => (
          <button
            key={f.path}
            onClick={() => onOpenFile?.(f.path)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-bg-elevated border border-border-subtle text-text-secondary hover:text-text-primary hover:border-border-default transition-colors cursor-pointer font-mono truncate max-w-[180px]"
            title={f.path}
          >
            <FileText size={10} className="flex-shrink-0" />
            <span className="truncate">{f.name}</span>
          </button>
        ))}
        {total > files.length && (
          <span className="text-text-tertiary flex-shrink-0">
            {t('tasks.drawerArtifactsMore', { count: total - files.length })}
          </span>
        )}
      </div>
    </div>
  );
}
