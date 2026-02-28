import { useState } from 'react';
import { Download, Loader2, Trash2, Check, RotateCcw, Power, PowerOff } from 'lucide-react';
import clsx from 'clsx';
import type { LocalModel, DownloadProgress as DownloadProgressType, EngineStatus } from '../../../types/models';
import type { DiskSpace } from '../../../types/ipc';
import DownloadProgress from './DownloadProgress';

interface LocalModelCardProps {
  model: LocalModel;
  engineStatus: EngineStatus;
  downloadProgress: DownloadProgressType | undefined;
  diskSpace: DiskSpace | null;
  isRecommended: boolean;
  onDownload: (modelId: string) => Promise<void>;
  onCancelDownload: (modelId: string) => Promise<void>;
  onDelete: (modelId: string) => Promise<void>;
  onLoad: (modelId: string) => Promise<void>;
  onUnload: () => Promise<void>;
}

const TIER_COLORS: Record<string, string> = {
  starter: 'bg-emerald-500/15 text-emerald-400',
  balanced: 'bg-blue-500/15 text-blue-400',
  power: 'bg-purple-500/15 text-purple-400',
};

function formatSize(bytes: number): string {
  return `~${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

function formatContext(length: number): string {
  if (length >= 1_000_000) return `${(length / 1_000).toFixed(0)}K`;
  if (length >= 1_000) return `${(length / 1_000).toFixed(0)}K`;
  return String(length);
}

export default function LocalModelCard({
  model,
  engineStatus,
  downloadProgress,
  diskSpace,
  isRecommended,
  onDownload,
  onCancelDownload,
  onDelete,
  onLoad,
  onUnload,
}: LocalModelCardProps) {
  const [actionLoading, setActionLoading] = useState(false);

  const isLoaded = engineStatus.loaded_model_id === model.id;
  const isLoading = engineStatus.state === 'loading' && engineStatus.loaded_model_id === model.id;
  const isDownloading = !!downloadProgress && downloadProgress.status === 'downloading';
  const isVerifying = !!downloadProgress && downloadProgress.status === 'verifying';
  const isInterrupted = model.status === 'interrupted';
  const isDownloaded = model.status === 'downloaded';
  const isAvailable = model.status === 'available';

  const insufficientDisk =
    isAvailable && diskSpace ? diskSpace.free < model.size_bytes * 1.1 : false;

  async function handleAction(action: () => Promise<void>) {
    setActionLoading(true);
    try {
      await action();
    } catch (e) {
      console.error(e);
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <div
      className={clsx(
        'bg-bg-surface border rounded-lg p-4',
        isLoaded ? 'border-accent/30' : 'border-border-subtle',
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-medium text-text-primary">{model.name}</h4>
          <span
            className={clsx(
              'text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded',
              TIER_COLORS[model.tier],
            )}
          >
            {model.tier}
          </span>
          {isRecommended && (
            <span className="text-[10px] font-medium text-accent bg-accent/10 px-1.5 py-0.5 rounded">
              Recommended
            </span>
          )}
          {isLoaded && (
            <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">
              <Check size={10} />
              Loaded
            </span>
          )}
        </div>
      </div>

      {/* Tagline */}
      <p className="text-xs text-text-tertiary mb-3">{model.tagline}</p>

      {/* Specs */}
      <div className="flex items-center gap-3 text-xs text-text-tertiary mb-4">
        <span>{formatSize(model.size_bytes)}</span>
        <span className="text-border-default">&middot;</span>
        <span>{model.requires_ram_gb} GB RAM</span>
        <span className="text-border-default">&middot;</span>
        <span>{formatContext(model.context_length)} context</span>
        {model.architecture === 'moe' && (
          <>
            <span className="text-border-default">&middot;</span>
            <span>MoE ({model.active_params} active)</span>
          </>
        )}
      </div>

      {/* Download progress */}
      {(isDownloading || isVerifying) && downloadProgress && (
        <div className="mb-3">
          <DownloadProgress
            progress={downloadProgress}
            onCancel={() => onCancelDownload(model.id)}
          />
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2">
        {/* Available — Download button */}
        {isAvailable && !isDownloading && (
          <button
            onClick={() => handleAction(() => onDownload(model.id))}
            disabled={actionLoading || insufficientDisk}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
              insufficientDisk
                ? 'bg-bg-elevated text-text-tertiary cursor-not-allowed'
                : 'bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 cursor-pointer',
            )}
            title={insufficientDisk ? 'Not enough disk space' : undefined}
          >
            <Download size={12} />
            Download
          </button>
        )}

        {/* Interrupted — Resume button */}
        {isInterrupted && !isDownloading && (
          <button
            onClick={() => handleAction(() => onDownload(model.id))}
            disabled={actionLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 border border-amber-500/20 transition-colors cursor-pointer"
          >
            <RotateCcw size={12} />
            Resume
          </button>
        )}

        {/* Downloaded but not loaded — Load button */}
        {isDownloaded && !isLoaded && !isLoading && (
          <button
            onClick={() => handleAction(() => onLoad(model.id))}
            disabled={actionLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors cursor-pointer"
          >
            <Power size={12} />
            Load
          </button>
        )}

        {/* Loading spinner */}
        {isLoading && (
          <span className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary">
            <Loader2 size={12} className="animate-spin" />
            Loading model...
          </span>
        )}

        {/* Loaded — Unload button */}
        {isLoaded && (
          <button
            onClick={() => handleAction(() => onUnload())}
            disabled={actionLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-bg-elevated text-text-secondary hover:bg-bg-hover border border-border-subtle transition-colors cursor-pointer"
          >
            <PowerOff size={12} />
            Unload
          </button>
        )}

        {/* Delete — shown for downloaded/interrupted, disabled if loaded */}
        {(isDownloaded || isInterrupted) && (
          <button
            onClick={() => handleAction(() => onDelete(model.id))}
            disabled={actionLoading || isLoaded}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
              isLoaded
                ? 'bg-bg-elevated text-text-tertiary cursor-not-allowed'
                : 'text-text-tertiary hover:text-red-400 hover:bg-red-500/10 cursor-pointer',
            )}
            title={isLoaded ? 'Unload the model first' : 'Delete model file'}
          >
            <Trash2 size={12} />
            Delete
          </button>
        )}
      </div>

      {/* Insufficient disk warning */}
      {insufficientDisk && (
        <p className="text-[10px] text-amber-400 mt-2">
          Not enough disk space ({formatSize(model.size_bytes)} required)
        </p>
      )}
    </div>
  );
}
