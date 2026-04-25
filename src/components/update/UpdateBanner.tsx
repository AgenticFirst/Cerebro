import { Download, RefreshCw, AlertCircle, X, ExternalLink } from 'lucide-react';
import { useUpdate } from '../../context/UpdateContext';

function formatMB(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 MB';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function UpdateBanner() {
  const {
    status,
    info,
    progress,
    errorMessage,
    isDismissed,
    startDownload,
    dismiss,
    openReleasePage,
  } = useUpdate();

  if (!info) return null;
  if (status === 'idle') return null;
  if (status === 'available' && isDismissed) return null;

  const renderContent = () => {
    if (status === 'downloading') {
      const pct = progress ? Math.min(100, Math.round(progress.percent)) : 0;
      return (
        <>
          <div className="w-8 h-8 rounded-lg bg-accent/20 text-accent flex items-center justify-center flex-shrink-0 mt-0.5">
            <RefreshCw size={15} className="animate-spin" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-text-primary">
              Downloading Cerebro {info.version}…
            </div>
            <div className="text-xs text-text-secondary mt-0.5">
              {progress
                ? `${formatMB(progress.transferred)} / ${formatMB(progress.total)} (${pct}%)`
                : 'Starting download…'}
            </div>
            <div className="mt-2 h-1.5 w-full rounded-full bg-white/[0.06] overflow-hidden">
              <div
                className="h-full bg-accent transition-all duration-150"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        </>
      );
    }

    if (status === 'downloaded') {
      return (
        <>
          <div className="w-8 h-8 rounded-lg bg-accent/20 text-accent flex items-center justify-center flex-shrink-0 mt-0.5">
            <Download size={15} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-text-primary">
              Update downloaded — installer opened
            </div>
            <div className="text-xs text-text-secondary mt-0.5 leading-relaxed">
              Finish installing Cerebro {info.version} from the installer window, then relaunch the app.
            </div>
          </div>
        </>
      );
    }

    if (status === 'error') {
      return (
        <>
          <div className="w-8 h-8 rounded-lg bg-red-500/20 text-red-400 flex items-center justify-center flex-shrink-0 mt-0.5">
            <AlertCircle size={15} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-text-primary">
              Couldn't download the update
            </div>
            <div className="text-xs text-text-secondary mt-0.5 leading-relaxed">
              {errorMessage ?? 'Unknown error.'} You can grab the installer manually from the release page.
            </div>
            <div className="flex items-center gap-2 mt-2.5">
              <button
                onClick={openReleasePage}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent text-bg-base hover:bg-accent/90 transition-colors cursor-pointer inline-flex items-center gap-1.5"
              >
                <ExternalLink size={12} /> Open release page
              </button>
              <button
                onClick={() => void startDownload()}
                className="px-3 py-1.5 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-white/[0.04] transition-colors cursor-pointer"
              >
                Retry
              </button>
            </div>
          </div>
        </>
      );
    }

    // status === 'available'
    return (
      <>
        <div className="w-8 h-8 rounded-lg bg-accent/20 text-accent flex items-center justify-center flex-shrink-0 mt-0.5">
          <Download size={15} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-text-primary">
            Cerebro {info.version} is available
          </div>
          {info.notes ? (
            <div className="text-xs text-text-secondary mt-0.5 leading-relaxed line-clamp-2">
              {info.notes}
            </div>
          ) : null}
          <div className="flex items-center gap-2 mt-2.5">
            <button
              onClick={() => void startDownload()}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent text-bg-base hover:bg-accent/90 transition-colors cursor-pointer"
            >
              Update now
            </button>
            <button
              onClick={openReleasePage}
              className="px-3 py-1.5 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-white/[0.04] transition-colors cursor-pointer inline-flex items-center gap-1.5"
            >
              <ExternalLink size={12} /> View release notes
            </button>
          </div>
        </div>
      </>
    );
  };

  return (
    <div className="mx-4 mt-3">
      <div className="mx-auto max-w-3xl flex items-start gap-3 px-4 py-3 rounded-lg border border-accent/30 bg-accent/10">
        {renderContent()}
        {status !== 'downloading' && (
          <button
            onClick={dismiss}
            className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-white/[0.04] transition-colors cursor-pointer flex-shrink-0"
            aria-label="Dismiss update banner"
          >
            <X size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
