import { X } from 'lucide-react';
import type { DownloadProgress as DownloadProgressType } from '../../../types/models';

interface DownloadProgressProps {
  progress: DownloadProgressType;
  onCancel: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  return `${(bytes / 1_000).toFixed(0)} KB`;
}

function formatSpeed(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(0)} MB/s`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(0)} KB/s`;
  return `${bps.toFixed(0)} B/s`;
}

function formatEta(seconds: number): string {
  if (seconds <= 0 || !isFinite(seconds)) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function DownloadProgress({ progress, onCancel }: DownloadProgressProps) {
  const percent =
    progress.total_bytes > 0
      ? Math.min(100, Math.round((progress.downloaded_bytes / progress.total_bytes) * 100))
      : 0;

  const isVerifying = progress.status === 'verifying';

  return (
    <div className="space-y-2">
      {/* Progress bar */}
      <div className="h-2 rounded-full bg-bg-base overflow-hidden">
        <div
          className="h-full rounded-full bg-accent transition-all duration-300 ease-out"
          style={{ width: `${isVerifying ? 100 : percent}%` }}
        />
      </div>

      {/* Stats line */}
      <div className="flex items-center justify-between text-xs text-text-tertiary">
        <span>
          {isVerifying ? (
            'Verifying download...'
          ) : (
            <>
              {formatBytes(progress.downloaded_bytes)} / {formatBytes(progress.total_bytes)}
              {progress.speed_bps > 0 && <> &middot; {formatSpeed(progress.speed_bps)}</>}
              {progress.eta_seconds > 0 && <> &middot; ETA {formatEta(progress.eta_seconds)}</>}
            </>
          )}
        </span>
        <div className="flex items-center gap-2">
          <span className="font-medium text-text-secondary">{percent}%</span>
          <button
            onClick={onCancel}
            className="p-0.5 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer"
            title="Cancel download"
          >
            <X size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}
