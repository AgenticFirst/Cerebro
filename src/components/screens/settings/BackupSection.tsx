import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  Download,
  Upload,
  RotateCcw,
  AlertTriangle,
  Loader2,
  FolderOpen,
} from 'lucide-react';
import AlertModal from '../../ui/AlertModal';
import { useToast } from '../../../context/ToastContext';

interface BackupStats {
  conversations: number;
  messages: number;
  tasks: number;
  experts: number;
  routines: number;
  files_bytes: number;
  file_count: number;
}

interface InspectResult {
  ok: boolean;
  compatible: boolean;
  manifest: {
    cerebro_version?: string;
    created_at?: string;
    contents?: string[];
    stats?: BackupStats;
    excluded?: string[];
  };
  warnings: string[];
  error?: string | null;
}

interface LastBackup {
  last_backup_at: string | null;
  last_backup_path: string | null;
  last_backup_size_bytes: number | null;
}

interface RollbackEntry {
  id: string;
  path: string;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '';
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function suggestedBackupName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `cerebro-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(
    d.getHours(),
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}.cerebro-backup`;
}

export default function BackupSection() {
  const { t } = useTranslation();
  const { addToast } = useToast();

  const [includeModels, setIncludeModels] = useState(false);
  const [estimatedBytes, setEstimatedBytes] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<{
    path: string;
    inspect: InspectResult;
  } | null>(null);
  const [lastBackup, setLastBackup] = useState<LastBackup | null>(null);
  const [rollbacks, setRollbacks] = useState<RollbackEntry[]>([]);
  const [undoing, setUndoing] = useState<string | null>(null);

  // ── Loaders ─────────────────────────────────────────────────────

  const refreshLastBackup = useCallback(async () => {
    try {
      const res = await window.cerebro.invoke<LastBackup>({
        method: 'GET',
        path: '/backup/last',
      });
      if (res.ok) setLastBackup(res.data);
    } catch {
      /* backend not ready yet — try again later */
    }
  }, []);

  const refreshRollbacks = useCallback(async () => {
    try {
      const res = await window.cerebro.invoke<{ rollbacks: RollbackEntry[] }>({
        method: 'GET',
        path: '/backup/rollbacks',
      });
      if (res.ok) setRollbacks(res.data.rollbacks ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  const refreshEstimate = useCallback(async (modelsOn: boolean) => {
    try {
      const res = await window.cerebro.invoke<{ bytes: number }>({
        method: 'POST',
        path: '/backup/estimate',
        body: { include_models: modelsOn },
      });
      if (res.ok) setEstimatedBytes(res.data.bytes);
    } catch {
      setEstimatedBytes(null);
    }
  }, []);

  useEffect(() => {
    refreshLastBackup();
    refreshRollbacks();
  }, [refreshLastBackup, refreshRollbacks]);

  useEffect(() => {
    refreshEstimate(includeModels);
  }, [includeModels, refreshEstimate]);

  // ── Create ──────────────────────────────────────────────────────

  const handleCreate = useCallback(async () => {
    if (exporting) return;
    const destPath = await window.cerebro.backup.pickExportPath(suggestedBackupName());
    if (!destPath) return;
    setExporting(true);
    try {
      const appVersion = await window.cerebro.backup.appVersion();
      const res = await window.cerebro.invoke<{ ok: boolean; size_bytes: number }>({
        method: 'POST',
        path: '/backup/export',
        body: { dest_path: destPath, include_models: includeModels, app_version: appVersion },
        timeout: 600_000,
      });
      if (!res.ok) {
        const detail = (res.data as { detail?: string } | null)?.detail ?? 'unknown error';
        addToast(t('backup.exportFailed', { detail }), 'error');
        return;
      }
      addToast(t('backup.exportSucceeded', { size: formatBytes(res.data.size_bytes) }), 'success');
      refreshLastBackup();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addToast(t('backup.exportFailed', { detail: message }), 'error');
    } finally {
      setExporting(false);
    }
  }, [addToast, exporting, includeModels, refreshLastBackup, t]);

  // ── Restore ─────────────────────────────────────────────────────

  const handlePickAndInspect = useCallback(async () => {
    if (inspecting || applying) return;
    const path = await window.cerebro.backup.pickImportFile();
    if (!path) return;
    setInspecting(true);
    try {
      const appVersion = await window.cerebro.backup.appVersion();
      const res = await window.cerebro.invoke<InspectResult>({
        method: 'POST',
        path: '/backup/inspect',
        body: { path, app_version: appVersion },
      });
      if (!res.ok || !res.data.ok) {
        const detail =
          res.data?.error ?? (res.data as { detail?: string } | null)?.detail ?? 'unknown error';
        addToast(t('backup.inspectFailed', { detail }), 'error');
        return;
      }
      setPendingRestore({ path, inspect: res.data });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addToast(t('backup.inspectFailed', { detail: message }), 'error');
    } finally {
      setInspecting(false);
    }
  }, [addToast, applying, inspecting, t]);

  const handleConfirmRestore = useCallback(async () => {
    if (!pendingRestore) return;
    setApplying(true);
    try {
      await window.cerebro.backup.applyAndRelaunch(pendingRestore.path);
      // applyAndRelaunch triggers app.relaunch + app.quit, so we never reach
      // the next line in normal operation. If we do, surface a soft error.
      addToast(t('backup.applyDidNotRelaunch'), 'error');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addToast(t('backup.applyFailed', { detail: message }), 'error');
      setApplying(false);
    }
  }, [addToast, pendingRestore, t]);

  // ── Undo ────────────────────────────────────────────────────────

  const handleUndo = useCallback(
    async (rollbackId: string) => {
      if (undoing) return;
      setUndoing(rollbackId);
      try {
        const res = await window.cerebro.invoke<{ ok: boolean }>({
          method: 'POST',
          path: '/backup/undo',
          body: { rollback_id: rollbackId },
        });
        if (!res.ok) {
          const detail = (res.data as { detail?: string } | null)?.detail ?? 'unknown error';
          addToast(t('backup.undoFailed', { detail }), 'error');
          setUndoing(null);
          return;
        }
        // The pending-restore marker is on disk now. Relaunch so the swap
        // happens with no live SQLite connection.
        await window.cerebro.backup.relaunch();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        addToast(t('backup.undoFailed', { detail: message }), 'error');
        setUndoing(null);
      }
    },
    [addToast, t, undoing],
  );

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div>
      <h2 className="text-base font-semibold text-text-primary mb-1">{t('backup.title')}</h2>
      <p className="text-xs text-text-secondary mb-6">{t('backup.description')}</p>

      {/* Create card */}
      <div className="rounded-lg border border-border-subtle bg-bg-surface p-5 mb-3">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0">
            <Archive size={18} className="text-accent" strokeWidth={1.75} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-medium text-text-primary mb-0.5">
              {t('backup.create.title')}
            </h3>
            <p className="text-xs text-text-secondary leading-relaxed">
              {t('backup.create.description')}
            </p>

            <label className="flex items-center gap-2 mt-3 cursor-pointer select-none w-fit">
              <input
                type="checkbox"
                checked={includeModels}
                onChange={(e) => setIncludeModels(e.target.checked)}
                className="w-3.5 h-3.5 rounded accent-accent cursor-pointer"
              />
              <span className="text-xs text-text-secondary">
                {t('backup.create.includeModels')}
              </span>
            </label>

            <div className="flex items-center justify-between gap-3 mt-4">
              <p className="text-[11px] text-text-tertiary">
                {estimatedBytes != null
                  ? t('backup.create.estimatedSize', { size: formatBytes(estimatedBytes) })
                  : ' '}
              </p>
              <button
                onClick={handleCreate}
                disabled={exporting}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent/15 hover:bg-accent/25 text-accent text-[13px] font-medium border border-accent/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {exporting ? (
                  <>
                    <Loader2 size={13} className="animate-spin" />
                    {t('backup.create.inProgress')}
                  </>
                ) : (
                  <>
                    <Download size={13} strokeWidth={2} />
                    {t('backup.create.cta')}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Restore card */}
      <div className="rounded-lg border border-border-subtle bg-bg-surface p-5 mb-3">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0">
            <Upload size={18} className="text-accent" strokeWidth={1.75} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-medium text-text-primary mb-0.5">
              {t('backup.restore.title')}
            </h3>
            <p className="text-xs text-text-secondary leading-relaxed">
              {t('backup.restore.description')}
            </p>

            <div className="flex justify-end mt-4">
              <button
                onClick={handlePickAndInspect}
                disabled={inspecting || applying}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-bg-elevated hover:bg-bg-hover text-text-primary text-[13px] font-medium border border-border-subtle transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {inspecting ? (
                  <>
                    <Loader2 size={13} className="animate-spin" />
                    {t('backup.restore.inspecting')}
                  </>
                ) : (
                  <>
                    <Upload size={13} strokeWidth={2} />
                    {t('backup.restore.cta')}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Last backup */}
      {lastBackup?.last_backup_at && (
        <div className="flex items-center justify-between gap-3 py-3 border-b border-white/[0.06]">
          <div className="min-w-0">
            <p className="text-xs text-text-secondary truncate">
              {t('backup.lastBackup', {
                when: relativeTime(lastBackup.last_backup_at),
                size: lastBackup.last_backup_size_bytes
                  ? formatBytes(lastBackup.last_backup_size_bytes)
                  : '?',
              })}
            </p>
            <p
              className="text-[11px] text-text-tertiary truncate"
              title={lastBackup.last_backup_path ?? ''}
            >
              {lastBackup.last_backup_path}
            </p>
          </div>
          {lastBackup.last_backup_path && (
            <button
              onClick={() => window.cerebro.backup.revealPath(lastBackup.last_backup_path!)}
              className="inline-flex items-center gap-1 text-[11px] text-text-tertiary hover:text-text-primary transition-colors cursor-pointer flex-shrink-0"
            >
              <FolderOpen size={12} />
              {t('backup.revealFile')}
            </button>
          )}
        </div>
      )}

      {/* Rollback snapshots */}
      {rollbacks.length > 0 && (
        <div className="mt-5">
          <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-text-tertiary mb-2">
            {t('backup.rollbacks.title')}
          </h3>
          <p className="text-xs text-text-secondary mb-3">{t('backup.rollbacks.description')}</p>
          <div className="space-y-1.5">
            {rollbacks.map((rb) => (
              <div
                key={rb.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border-subtle bg-bg-surface px-3 py-2"
              >
                <p className="text-xs text-text-primary font-mono">{rb.id}</p>
                <button
                  onClick={() => handleUndo(rb.id)}
                  disabled={undoing != null}
                  className="inline-flex items-center gap-1 text-[12px] text-text-secondary hover:text-accent transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {undoing === rb.id ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <RotateCcw size={12} />
                  )}
                  {t('backup.rollbacks.undo')}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Cross-machine note */}
      <p className="text-[11px] text-text-tertiary mt-6 leading-relaxed">
        {t('backup.crossMachineNote')}
      </p>

      {/* Preview modal */}
      {pendingRestore && (
        <RestorePreviewModal
          inspect={pendingRestore.inspect}
          applying={applying}
          onCancel={() => setPendingRestore(null)}
          onConfirm={handleConfirmRestore}
        />
      )}
    </div>
  );
}

// ── Preview modal ─────────────────────────────────────────────────

function RestorePreviewModal({
  inspect,
  applying,
  onCancel,
  onConfirm,
}: {
  inspect: InspectResult;
  applying: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const stats = inspect.manifest.stats;
  const createdAt = inspect.manifest.created_at
    ? new Date(inspect.manifest.created_at).toLocaleString()
    : '?';
  const version = inspect.manifest.cerebro_version ?? '?';

  const lines: string[] = [];
  if (stats) {
    lines.push(
      t('backup.preview.stats', {
        conversations: stats.conversations,
        tasks: stats.tasks,
        experts: stats.experts,
        size: formatBytes(stats.files_bytes),
      }),
    );
  }
  lines.push(t('backup.preview.created', { when: createdAt }));
  lines.push(t('backup.preview.version', { version }));

  const message = [...lines, '', t('backup.preview.warning')].join('\n');

  const blocked =
    !inspect.compatible || (inspect.warnings && inspect.warnings.length > 0 && !inspect.compatible);
  const warning = inspect.warnings && inspect.warnings[0];

  return (
    <AlertModal
      icon={<AlertTriangle size={18} className="text-red-400" />}
      iconTone="danger"
      title={t('backup.preview.title')}
      message={blocked && warning ? warning : message}
      actions={[
        {
          label: t('backup.preview.cancel'),
          onClick: onCancel,
        },
        {
          label: applying ? t('backup.preview.applying') : t('backup.preview.confirm'),
          onClick: onConfirm,
          primary: true,
          variant: 'danger',
        },
      ].filter((a, i) => (blocked && i === 1 ? false : true))}
      onClose={applying ? () => undefined : onCancel}
    />
  );
}
