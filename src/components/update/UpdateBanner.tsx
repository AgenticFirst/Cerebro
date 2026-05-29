import { Download, RefreshCw, AlertCircle, X, ExternalLink, CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUpdate } from '../../context/UpdateContext';

function formatMB(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 MB';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function UpdateBanner() {
  const { t } = useTranslation();
  const {
    status,
    info,
    progress,
    errorKind,
    retryCooldownSeconds,
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
              {t('updateBanner.downloading.title', { version: info.version })}
            </div>
            <div className="text-xs text-text-secondary mt-0.5">
              {progress
                ? t('updateBanner.downloading.progress', {
                    transferred: formatMB(progress.transferred),
                    total: formatMB(progress.total),
                    percent: pct,
                  })
                : t('updateBanner.downloading.starting')}
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
        title = t('updateBanner.ready.titleReady', { version: info.version });
        detail = t('updateBanner.ready.detailAppImage');
        primaryLabel = t('updateBanner.ready.restartToUpdate');
      } else if (isLinuxPackage) {
        title = t('updateBanner.ready.titleDownloaded', { version: info.version });
        detail = t('updateBanner.ready.detailLinuxPackage');
        primaryLabel = t('updateBanner.ready.revealInstaller');
      } else {
        title = t('updateBanner.ready.titleDownloaded', { version: info.version });
        detail = t('updateBanner.ready.detailDefault');
        primaryLabel = t('updateBanner.ready.openInstaller');
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
                <ExternalLink size={12} /> {t('updateBanner.ready.releaseNotes')}
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
              {t('updateBanner.applying.title', { version: info.version })}
            </div>
            <div className="text-xs text-text-secondary mt-0.5 leading-relaxed">
              {t('updateBanner.applying.detail')}
            </div>
          </div>
        </>
      );
    }

    if (status === 'error') {
      // Pick reassuring, kind-specific copy. The renderer's `errorKind` is
      // set by `UPDATE_ERROR` events emitted from main, so the categorisation
      // happens server-side where the failure mode is actually known —
      // we don't string-match on error.message.
      //
      // Fallback: `errorKind` can briefly be null on a stale state (e.g. an
      // earlier IPC-layer rejection that didn't ride on UPDATE_ERROR). In
      // that case treat it as `'unknown'` and show the calm generic copy.
      const kind = errorKind ?? 'unknown';
      const isApplyKind = kind === 'apply';
      const isDisabled = kind === 'disabled';
      const copy = {
        network: {
          title: t('updateBanner.error.networkTitle'),
          body: t('updateBanner.error.networkBody'),
        },
        verify: {
          title: t('updateBanner.error.verifyTitle'),
          body: t('updateBanner.error.verifyBody'),
        },
        apply: {
          title: t('updateBanner.error.applyTitle'),
          body: t('updateBanner.error.applyBody'),
        },
        disabled: {
          title: t('updateBanner.error.disabledTitle'),
          body: t('updateBanner.error.disabledBody'),
        },
        unknown: {
          title: t('updateBanner.error.unknownTitle'),
          body: t('updateBanner.error.unknownBody'),
        },
      }[kind];
      const onRetry = () => void (isApplyKind ? applyUpdate() : startDownload());
      const retryLabel =
        retryCooldownSeconds > 0
          ? t('updateBanner.error.networkRetryCountdown', { seconds: retryCooldownSeconds })
          : t('updateBanner.error.retry');
      return (
        <>
          <div className="w-8 h-8 rounded-lg bg-red-500/20 text-red-400 flex items-center justify-center flex-shrink-0 mt-0.5">
            <AlertCircle size={15} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-text-primary">{copy.title}</div>
            <div className="text-xs text-text-secondary mt-0.5 leading-relaxed">{copy.body}</div>
            {/* Reassurance-first layout: when the user can recover by retrying
                we show Retry as the PRIMARY action. "Open release page" stays
                available as a secondary escape hatch for apply/verify/
                disabled flows where retrying alone is unlikely to help. */}
            <div className="flex items-center gap-2 mt-2.5">
              {!isDisabled && (
                <button
                  onClick={onRetry}
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent text-bg-base hover:bg-accent/90 transition-colors cursor-pointer"
                >
                  {retryLabel}
                </button>
              )}
              <button
                onClick={openReleasePage}
                className={
                  isDisabled
                    ? 'px-3 py-1.5 rounded-md text-xs font-medium bg-accent text-bg-base hover:bg-accent/90 transition-colors cursor-pointer inline-flex items-center gap-1.5'
                    : 'px-3 py-1.5 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-white/[0.04] transition-colors cursor-pointer inline-flex items-center gap-1.5'
                }
              >
                <ExternalLink size={12} /> {t('updateBanner.error.openReleasePage')}
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
            {t('updateBanner.available.title', { version: info.version })}
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
              {t('updateBanner.available.updateNow')}
            </button>
            <button
              onClick={openReleasePage}
              className="px-3 py-1.5 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-white/[0.04] transition-colors cursor-pointer inline-flex items-center gap-1.5"
            >
              <ExternalLink size={12} /> {t('updateBanner.available.viewReleaseNotes')}
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
            aria-label={t('updateBanner.dismissAria')}
          >
            <X size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
