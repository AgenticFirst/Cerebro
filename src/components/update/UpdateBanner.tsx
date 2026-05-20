import { Download, RefreshCw, AlertCircle, X, ExternalLink, CheckCircle2 } from 'lucide-react';
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
    applyUpdate,
    dismiss,
    openReleasePage,
  } = useUpdate();

  if (!info) return null;
  if (status === 'idle') return null;
  if (status === 'available' && isDismissed) return null;

  const assetName = info.asset.name.toLowerCase();
  const isAppImage = assetName.endsWith('.appimage');
  const isLinuxPackage = assetName.endsWith('.deb') || assetName.endsWith('.rpm');

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

    if (status === 'ready') {
      // Asset-aware copy: AppImage gets a "Restart now" button (we control
      // the restart and can roll back on failure). .deb/.rpm get a "Reveal
      // installer" button (the user has to run dpkg/rpm themselves). macOS
      // .dmg / Windows Setup.exe get "Open installer".
      let title: string;
      let detail: string;
      let primaryLabel: string;
      if (isAppImage) {
        title = `Cerebro ${info.version} is ready to install`;
        detail = `Your chats, tasks, settings, and memory will be preserved. Cerebro will restart to apply the update.`;
        primaryLabel = 'Restart to update';
      } else if (isLinuxPackage) {
        title = `Cerebro ${info.version} downloaded`;
        detail = `Open the installer in your file manager to finish installing, then relaunch Cerebro. Your data is stored separately and won't be touched.`;
        primaryLabel = 'Reveal installer';
      } else {
        title = `Cerebro ${info.version} downloaded`;
        detail = `Open the installer to finish installing, then relaunch Cerebro. Your data is stored separately and won't be touched.`;
        primaryLabel = 'Open installer';
      }
      return (
        <>
          <div className="w-8 h-8 rounded-lg bg-accent/20 text-accent flex items-center justify-center flex-shrink-0 mt-0.5">
            <CheckCircle2 size={15} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-text-primary">{title}</div>
            <div className="text-xs text-text-secondary mt-0.5 leading-relaxed">{detail}</div>
            <div className="flex items-center gap-2 mt-2.5">
              <button
                onClick={() => void applyUpdate()}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent text-bg-base hover:bg-accent/90 transition-colors cursor-pointer"
              >
                {primaryLabel}
              </button>
              <button
                onClick={openReleasePage}
                className="px-3 py-1.5 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-white/[0.04] transition-colors cursor-pointer inline-flex items-center gap-1.5"
              >
                <ExternalLink size={12} /> Release notes
              </button>
            </div>
          </div>
        </>
      );
    }

    if (status === 'applying') {
      return (
        <>
          <div className="w-8 h-8 rounded-lg bg-accent/20 text-accent flex items-center justify-center flex-shrink-0 mt-0.5">
            <RefreshCw size={15} className="animate-spin" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-text-primary">
              Restarting Cerebro {info.version}…
            </div>
            <div className="text-xs text-text-secondary mt-0.5 leading-relaxed">
              Verifying the new version can launch. If anything goes wrong the previous version
              will be restored automatically.
            </div>
          </div>
        </>
      );
    }

    if (status === 'error') {
      // Errors come from either the download step OR the apply step.
      // - Download errors: retry the download.
      // - Apply errors (Linux AppImage launch failed): the binary was
      //   rolled back to the prior version, so retrying just kicks off the
      //   apply again (same artifact, no re-download). Either way, the
      //   user always has "Open release page" as an escape hatch.
      const cameFromApply = errorMessage?.includes("Couldn't start the new version") ?? false;
      return (
        <>
          <div className="w-8 h-8 rounded-lg bg-red-500/20 text-red-400 flex items-center justify-center flex-shrink-0 mt-0.5">
            <AlertCircle size={15} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-text-primary">
              {cameFromApply ? "Couldn't apply the update" : "Couldn't download the update"}
            </div>
            <div className="text-xs text-text-secondary mt-0.5 leading-relaxed">
              {errorMessage ?? 'Unknown error.'}{' '}
              {cameFromApply
                ? 'Your previous version is still installed. You can try again, or download the installer manually.'
                : 'You can grab the installer manually from the release page.'}
            </div>
            <div className="flex items-center gap-2 mt-2.5">
              <button
                onClick={openReleasePage}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent text-bg-base hover:bg-accent/90 transition-colors cursor-pointer inline-flex items-center gap-1.5"
              >
                <ExternalLink size={12} /> Open release page
              </button>
              <button
                onClick={() => void (cameFromApply ? applyUpdate() : startDownload())}
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

  // Only allow dismiss for states the user can return to later via the next
  // update-check cycle (`available`, `error`). `ready` stays sticky so the
  // user doesn't accidentally hide a pending restart and forget about it;
  // `downloading` and `applying` are in-progress and don't expose dismiss
  // either.
  const dismissable = status === 'available' || status === 'error';

  return (
    <div className="mx-4 mt-3">
      <div className="mx-auto max-w-3xl flex items-start gap-3 px-4 py-3 rounded-lg border border-accent/30 bg-accent/10">
        {renderContent()}
        {dismissable && (
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
