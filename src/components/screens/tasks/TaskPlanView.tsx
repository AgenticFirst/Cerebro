import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Task } from './types';

interface TaskPlanViewProps {
  task: Task;
  liveTask: unknown; // legacy prop retained for TaskDetailPanel call-site compatibility
}

interface PlanMdPayload {
  content: string;
  mtime: number | null;
}

const POLL_MS_ACTIVE = 2000;

export default function TaskPlanView({ task }: TaskPlanViewProps) {
  const { t } = useTranslation();
  const [plan, setPlan] = useState<PlanMdPayload | null>(() =>
    task.plan_md != null ? { content: task.plan_md, mtime: task.plan_md_mtime ?? null } : null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Poll PLAN.md while the task is in motion. Once the task settles we stop.
  const isActive = task.status === 'planning' || task.status === 'running';
  const taskIdRef = useRef(task.id);
  taskIdRef.current = task.id;

  const fetchPlan = useCallback(async (signal?: AbortSignal): Promise<PlanMdPayload | null> => {
    try {
      const res = await window.cerebro.invoke<PlanMdPayload>({
        method: 'GET',
        path: `/tasks/${taskIdRef.current}/plan-md`,
      });
      if (signal?.aborted) return null;
      if (res.ok) return { content: res.data.content, mtime: res.data.mtime ?? null };
    } catch {
      /* ignore — polling will try again */
    }
    return null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchPlan().then((p) => {
      if (!cancelled && p) setPlan(p);
    });
    return () => { cancelled = true; };
  }, [task.id, fetchPlan]);

  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(async () => {
      const fresh = await fetchPlan();
      if (!fresh) return;
      setPlan((prev) => {
        // Don't clobber an optimistic update while saving
        if (saving) return prev;
        if (prev && prev.mtime != null && fresh.mtime != null && fresh.mtime <= prev.mtime) {
          return prev;
        }
        return fresh;
      });
    }, POLL_MS_ACTIVE);
    return () => clearInterval(interval);
  }, [isActive, saving, fetchPlan]);

  const writePlan = useCallback(async (nextContent: string) => {
    setSaving(true);
    setError(null);
    try {
      const res = await window.cerebro.invoke<PlanMdPayload>({
        method: 'PUT',
        path: `/tasks/${taskIdRef.current}/plan-md`,
        body: { content: nextContent },
      });
      if (res.ok) {
        setPlan({ content: nextContent, mtime: res.data.mtime ?? null });
      } else {
        setError(t('taskPlan.checkboxToggleFailed'));
      }
    } catch {
      setError(t('taskPlan.checkboxToggleFailed'));
    } finally {
      setSaving(false);
    }
  }, [t]);

  const sourceLines = useMemo(() => (plan ? plan.content.split('\n') : []), [plan]);

  const onToggle = useCallback((lineIndex: number) => {
    // Can't mutate the plan while execute is actively editing it — the file
    // write would race the subprocess. Checkboxes only mutate from the UI
    // during planning / awaiting_plan_approval.
    if (task.status !== 'awaiting_plan_approval' && task.status !== 'planning') return;
    const line = sourceLines[lineIndex];
    if (!line) return;
    let toggled: string;
    if (line.includes('- [ ]')) {
      toggled = line.replace('- [ ]', '- [x]');
    } else if (line.includes('- [x]') || line.includes('- [X]')) {
      toggled = line.replace(/- \[[xX]\]/, '- [ ]');
    } else {
      return;
    }
    const nextLines = [...sourceLines];
    nextLines[lineIndex] = toggled;
    const next = nextLines.join('\n');
    // Optimistic update
    setPlan((prev) => (prev ? { ...prev, content: next } : prev));
    void writePlan(next);
  }, [sourceLines, task.status, writePlan]);

  const components = useMemo<Components>(() => ({
    input({ node, ...props }) {
      if (props.type !== 'checkbox') return <input {...props} />;
      const line = node?.position?.start?.line;
      const interactive = task.status === 'awaiting_plan_approval' || task.status === 'planning';
      return (
        <input
          type="checkbox"
          checked={Boolean(props.checked)}
          disabled={!interactive || saving}
          onChange={() => {
            if (typeof line === 'number') onToggle(line - 1);
          }}
          className="mr-2 cursor-pointer accent-accent disabled:cursor-not-allowed"
        />
      );
    },
    li({ children, className, ...props }) {
      const isTask = className?.includes('task-list-item') ?? false;
      return (
        <li
          className={isTask ? 'list-none flex items-start gap-1 my-1' : className}
          {...props}
        >
          {children}
        </li>
      );
    },
  }), [onToggle, saving, task.status]);

  if (!plan) {
    if (isActive) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center py-16 text-text-tertiary text-sm">
          <div className="flex items-center gap-2">
            <Loader2 size={16} className="animate-spin" />
            <span>{t('taskPlan.writingPlan')}</span>
          </div>
        </div>
      );
    }
    return (
      <div className="flex-1 flex flex-col items-center justify-center py-16 text-text-tertiary text-sm">
        <span>{t('taskPlan.noPlan')}</span>
      </div>
    );
  }

  return (
    <div className="px-6 py-5">
      {error && (
        <div className="mb-3 text-xs text-red-400 bg-red-500/5 border border-red-500/20 rounded-md px-3 py-2">
          {error}
        </div>
      )}
      <div className="prose prose-sm max-w-none prose-invert">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {plan.content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
