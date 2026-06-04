import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Cloud,
  CloudOff,
  Loader2,
  Lock,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import type { SupabaseStatus } from '../../../types/ipc';

type Phase =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'connecting' }
  | { kind: 'err'; error: string };

export default function SupabaseSyncSection({ showHeader = false }: { showHeader?: boolean } = {}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SupabaseStatus | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const [dbUrl, setDbUrl] = useState('');
  const [supabaseUrl, setSupabaseUrl] = useState('');
  const [supabaseKey, setSupabaseKey] = useState('');
  const [bucket, setBucket] = useState('cerebro');
  const [seed, setSeed] = useState(true);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    const s = await window.cerebro.supabase.status();
    setStatus(s);
    return s;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // While connected, poll sync status so the indicator stays live.
  useEffect(() => {
    if (status?.connected) {
      pollRef.current = setInterval(() => {
        void refresh();
      }, 5000);
      return () => {
        if (pollRef.current) clearInterval(pollRef.current);
      };
    }
  }, [status?.connected, refresh]);

  const handleConnect = useCallback(async () => {
    if (!dbUrl.trim()) return;
    setPhase({ kind: 'connecting' });
    const res = await window.cerebro.supabase.connect({
      dbUrl: dbUrl.trim(),
      supabaseUrl: supabaseUrl.trim(),
      supabaseKey: supabaseKey.trim(),
      storageBucket: bucket.trim() || 'cerebro',
      seed,
    });
    if (res.ok) {
      setPhase({ kind: 'idle' });
      setDbUrl('');
      setSupabaseKey('');
      await refresh();
    } else {
      setPhase({ kind: 'err', error: res.error ?? t('supabaseSync.connectFailed') });
    }
  }, [dbUrl, supabaseUrl, supabaseKey, bucket, seed, refresh, t]);

  const handleDisconnect = useCallback(async () => {
    const s = await window.cerebro.supabase.disconnect();
    setStatus(s);
  }, []);

  const handleSyncNow = useCallback(async () => {
    await window.cerebro.supabase.trigger();
    setTimeout(() => {
      void refresh();
    }, 600);
  }, [refresh]);

  const connected = !!status?.connected;
  const usingKeychain = status?.secretBackend === 'os-keychain';
  const sync = status?.sync ?? null;

  return (
    <div>
      {showHeader && (
        <>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-emerald-500/15 text-emerald-400">
              <Cloud size={18} />
            </div>
            <h2 className="text-lg font-medium text-text-primary">{t('supabaseSync.title')}</h2>
          </div>
          <p className="text-sm text-text-secondary mt-3 leading-relaxed">
            {t('supabaseSync.description')}
          </p>
        </>
      )}

      {/* Secret-at-rest banner */}
      {usingKeychain ? (
        <div className="mt-4 flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-300">
          <Lock size={14} className="mt-0.5 flex-shrink-0" />
          <span className="leading-relaxed">{t('supabaseSync.storageEncrypted')}</span>
        </div>
      ) : (
        <div className="mt-4 flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-warning/30 bg-warning/10 text-xs text-warning-text">
          <ShieldAlert size={14} className="mt-0.5 flex-shrink-0" />
          <span className="leading-relaxed">{t('supabaseSync.storagePlaintextFallback')}</span>
        </div>
      )}

      {/* Per-device integrations note */}
      <p className="mt-3 text-[11px] text-text-tertiary leading-relaxed">
        {t('supabaseSync.perDeviceNote')}
      </p>

      {connected ? (
        <div className="mt-5">
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-md bg-bg-surface border border-border-subtle text-sm">
            <CheckCircle2 size={15} className="text-emerald-400 flex-shrink-0" />
            <span className="text-text-secondary flex-1 truncate">
              {status?.supabaseUrl || t('supabaseSync.connected')}
            </span>
            <SyncBadge sync={sync} t={t} />
          </div>

          {sync?.last_error && (
            <div className="mt-2 flex items-start gap-1.5 text-xs text-red-400">
              <XCircle size={12} className="mt-0.5 flex-shrink-0" />
              <span>{sync.last_error}</span>
            </div>
          )}

          <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
            <StatusCell label={t('supabaseSync.pending')} value={String(sync?.pending ?? 0)} />
            <StatusCell
              label={t('supabaseSync.lastSynced')}
              value={
                sync?.last_synced_at
                  ? new Date(sync.last_synced_at).toLocaleTimeString()
                  : t('supabaseSync.never')
              }
            />
            <StatusCell label={t('supabaseSync.bucket')} value={status?.storageBucket || '—'} />
          </div>

          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              onClick={handleSyncNow}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-md font-medium bg-accent/15 text-accent hover:bg-accent/25"
            >
              <RefreshCw size={14} /> {t('supabaseSync.syncNow')}
            </button>
            <button
              type="button"
              onClick={handleDisconnect}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-md font-medium text-text-tertiary hover:text-red-400"
            >
              <CloudOff size={14} /> {t('supabaseSync.disconnect')}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          <Field label={t('supabaseSync.dbUrlLabel')} help={t('supabaseSync.dbUrlHelp')}>
            <input
              type="password"
              value={dbUrl}
              onChange={(e) => {
                setDbUrl(e.target.value);
                setPhase({ kind: 'idle' });
              }}
              placeholder="postgresql+psycopg://postgres:[password]@db.xxxx.supabase.co:5432/postgres"
              className={inputCls}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label={t('supabaseSync.projectUrlLabel')} help={t('supabaseSync.projectUrlHelp')}>
            <input
              type="text"
              value={supabaseUrl}
              onChange={(e) => setSupabaseUrl(e.target.value)}
              placeholder="https://xxxx.supabase.co"
              className={inputCls}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label={t('supabaseSync.keyLabel')} help={t('supabaseSync.keyHelp')}>
            <input
              type="password"
              value={supabaseKey}
              onChange={(e) => setSupabaseKey(e.target.value)}
              placeholder="service_role key (for file storage)"
              className={inputCls}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label={t('supabaseSync.bucketLabel')} help={t('supabaseSync.bucketHelp')}>
            <input
              type="text"
              value={bucket}
              onChange={(e) => setBucket(e.target.value)}
              placeholder="cerebro"
              className={inputCls}
            />
          </Field>

          <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={seed}
              onChange={(e) => setSeed(e.target.checked)}
              className="accent-accent"
            />
            {t('supabaseSync.seedExisting')}
          </label>

          {phase.kind === 'err' && (
            <div className="flex items-start gap-1.5 text-xs text-red-400">
              <XCircle size={13} className="mt-0.5 flex-shrink-0" />
              <span>{phase.error}</span>
            </div>
          )}

          <button
            type="button"
            onClick={handleConnect}
            disabled={!dbUrl.trim() || phase.kind === 'connecting'}
            className={clsx(
              'inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-md font-medium transition-colors',
              'bg-accent text-white hover:bg-accent-hover',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            {phase.kind === 'connecting' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Cloud size={14} />
            )}
            {phase.kind === 'connecting' ? t('supabaseSync.connecting') : t('supabaseSync.connect')}
          </button>
        </div>
      )}
    </div>
  );
}

const inputCls =
  'w-full bg-bg-surface border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50';

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-text-secondary">{label}</label>
      <p className="text-[11px] text-text-tertiary mt-0.5 mb-1.5 leading-relaxed">{help}</p>
      {children}
    </div>
  );
}

function SyncBadge({ sync, t }: { sync: SupabaseStatus['sync']; t: (k: string) => string }) {
  const status = sync?.status ?? 'idle';
  const map: Record<string, { cls: string; label: string; spin?: boolean }> = {
    syncing: { cls: 'text-accent', label: t('supabaseSync.statusSyncing'), spin: true },
    idle: { cls: 'text-emerald-400', label: t('supabaseSync.statusSynced') },
    offline: { cls: 'text-warning-text', label: t('supabaseSync.statusOffline') },
    error: { cls: 'text-red-400', label: t('supabaseSync.statusError') },
    disabled: { cls: 'text-text-tertiary', label: t('supabaseSync.statusDisabled') },
  };
  const v = map[status] ?? map.idle;
  return (
    <span className={clsx('inline-flex items-center gap-1 text-xs font-medium', v.cls)}>
      {v.spin ? (
        <Loader2 size={12} className="animate-spin" />
      ) : (
        <span className="w-1.5 h-1.5 rounded-full bg-current" />
      )}
      {v.label}
    </span>
  );
}

function StatusCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2 rounded-md bg-bg-surface border border-border-subtle">
      <div className="text-[10px] uppercase tracking-wider text-text-tertiary">{label}</div>
      <div className="mt-0.5 text-text-secondary truncate">{value}</div>
    </div>
  );
}
