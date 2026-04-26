import { useEffect } from 'react';
import { Mic, Volume2, Download, CheckCircle2, AlertCircle, X, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { useVoice, type VoiceCatalogModel } from '../../../context/VoiceContext';

function formatMB(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function ModelCard({ model }: { model: VoiceCatalogModel }) {
  const { startDownload, cancelDownload } = useVoice();

  const Icon = model.type === 'stt' ? Mic : Volume2;

  const handleDownload = () => {
    void startDownload(model.id).catch(() => {
      // Errors surface in the catalog as model.error after the next refresh.
    });
  };

  const handleCancel = () => {
    void cancelDownload(model.id);
  };

  const renderActions = () => {
    if (model.download_state === 'installed') {
      return (
        <div className="flex items-center gap-1.5 text-xs text-emerald-400">
          <CheckCircle2 size={14} />
          <span>Installed</span>
        </div>
      );
    }

    if (model.download_state === 'downloading') {
      const total = model.size_bytes;
      const downloaded = model.downloaded_bytes;
      const pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
      return (
        <div className="flex flex-col items-end gap-2 min-w-[160px]">
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            <RefreshCw size={12} className="animate-spin text-accent" />
            <span>{formatMB(downloaded)} / {formatMB(total)} ({pct}%)</span>
          </div>
          <div className="w-full h-1 rounded-full bg-white/[0.06] overflow-hidden">
            <div
              className="h-full bg-accent transition-all duration-150"
              style={{ width: `${pct}%` }}
            />
          </div>
          <button
            onClick={handleCancel}
            className="text-xs text-text-tertiary hover:text-text-primary inline-flex items-center gap-1 cursor-pointer"
          >
            <X size={11} /> Cancel
          </button>
        </div>
      );
    }

    if (model.download_state === 'failed') {
      return (
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-1.5 text-xs text-red-400">
            <AlertCircle size={14} />
            <span>Failed</span>
          </div>
          <button
            onClick={handleDownload}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent text-bg-base hover:bg-accent/90 transition-colors cursor-pointer inline-flex items-center gap-1.5"
          >
            <Download size={12} /> Retry
          </button>
        </div>
      );
    }

    // not_installed
    return (
      <button
        onClick={handleDownload}
        className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent text-bg-base hover:bg-accent/90 transition-colors cursor-pointer inline-flex items-center gap-1.5"
      >
        <Download size={12} />
        Download {formatMB(model.size_bytes)}
      </button>
    );
  };

  return (
    <div
      className={clsx(
        'flex items-start justify-between gap-4 px-4 py-3.5 rounded-lg border',
        model.download_state === 'installed'
          ? 'border-emerald-500/30 bg-emerald-500/5'
          : 'border-white/[0.06] bg-white/[0.02]',
      )}
    >
      <div className="flex items-start gap-3 flex-1 min-w-0">
        <div
          className={clsx(
            'w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5',
            model.download_state === 'installed'
              ? 'bg-emerald-500/15 text-emerald-400'
              : 'bg-accent/15 text-accent',
          )}
        >
          <Icon size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-text-primary">{model.name}</p>
            <span className="text-[10px] uppercase tracking-wide text-text-tertiary">
              {model.type === 'stt' ? 'Speech → Text' : 'Text → Speech'}
            </span>
          </div>
          <p className="text-xs text-text-secondary mt-0.5 leading-relaxed">
            {model.description}
          </p>
          {model.error && model.download_state === 'failed' && (
            <p className="text-xs text-red-400/80 mt-1.5 truncate" title={model.error}>
              {model.error}
            </p>
          )}
        </div>
      </div>
      <div className="flex-shrink-0">{renderActions()}</div>
    </div>
  );
}

export default function VoiceSection() {
  const { catalog, catalogLoading, refreshCatalog } = useVoice();

  useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog]);

  const allInstalled = catalog?.all_installed ?? false;

  return (
    <div>
      <h2 className="text-base font-semibold text-text-primary mb-1">Voice</h2>
      <p className="text-xs text-text-secondary mb-5">
        Voice models run fully on-device — no audio leaves your machine. Download
        each model once; total install size is roughly 480&nbsp;MB. Once both
        models are installed the call button appears on expert profiles.
      </p>

      {!catalog && catalogLoading ? (
        <div className="flex items-center justify-center py-12 text-xs text-text-tertiary">
          <RefreshCw size={14} className="animate-spin mr-2" /> Loading voice catalog…
        </div>
      ) : (
        <div className="space-y-2.5">
          {catalog?.models.map((m) => (
            <ModelCard key={m.id} model={m} />
          ))}
        </div>
      )}

      {allInstalled && (
        <div
          className={clsx(
            'mt-6 px-4 py-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5',
            'flex items-start gap-3',
          )}
        >
          <CheckCircle2 size={16} className="text-emerald-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-text-primary">Voice is ready</p>
            <p className="text-xs text-text-secondary mt-0.5">
              Open any expert profile and click the call button to start a hands-free conversation.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
