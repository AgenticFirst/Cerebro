import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Eye, EyeOff, Loader2, Lock, RefreshCw, ShieldAlert, Trash2, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { GitHubIcon } from '../../icons/BrandIcons';
import type { GitHubRepoSummary, GitHubStatusResponse } from '../../../types/ipc';

type VerifyState =
  | { kind: 'idle' }
  | { kind: 'verifying' }
  | { kind: 'ok'; login: string | null }
  | { kind: 'err'; error: string };

interface GitHubSectionProps {
  showHeader?: boolean;
}

export default function GitHubSection({ showHeader = false }: GitHubSectionProps = {}) {
  const { t } = useTranslation();
  const [tokenDraft, setTokenDraft] = useState('');
  const [editingToken, setEditingToken] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [status, setStatus] = useState<GitHubStatusResponse | null>(null);
  const [verify, setVerify] = useState<VerifyState>({ kind: 'idle' });

  const [accessibleRepos, setAccessibleRepos] = useState<GitHubRepoSummary[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [addRepoDraft, setAddRepoDraft] = useState('');

  const refreshStatus = useCallback(async () => {
    const s = await window.cerebro.github.status();
    setStatus(s);
  }, []);

  const refreshRepos = useCallback(async () => {
    setReposLoading(true);
    const res = await window.cerebro.github.listRepos();
    setReposLoading(false);
    if (res.ok && res.repos) setAccessibleRepos(res.repos);
  }, []);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  // Live status updates from the bridge poller.
  useEffect(() => {
    return window.cerebro.github.onStatusChanged((s) => setStatus(s));
  }, []);

  useEffect(() => {
    if (status?.hasToken) void refreshRepos();
    else setAccessibleRepos([]);
  }, [status?.hasToken, refreshRepos]);

  const resetTokenEditor = useCallback(() => {
    setTokenDraft('');
    setEditingToken(false);
    setShowToken(false);
    setVerify({ kind: 'idle' });
  }, []);

  const handleVerify = useCallback(async () => {
    if (!tokenDraft.trim()) return;
    setVerify({ kind: 'verifying' });
    const res = await window.cerebro.github.verify(tokenDraft.trim());
    if (res.ok) setVerify({ kind: 'ok', login: res.login ?? null });
    else setVerify({ kind: 'err', error: res.error ?? 'Verification failed' });
  }, [tokenDraft]);

  const handleSaveToken = useCallback(async () => {
    if (!tokenDraft.trim()) return;
    const res = await window.cerebro.github.setToken(tokenDraft.trim());
    if (res.ok) {
      resetTokenEditor();
      await refreshStatus();
    } else {
      setVerify({ kind: 'err', error: res.error ?? 'Save failed' });
    }
  }, [tokenDraft, refreshStatus, resetTokenEditor]);

  const handleClearToken = useCallback(async () => {
    await window.cerebro.github.clearToken();
    resetTokenEditor();
    await refreshStatus();
  }, [refreshStatus, resetTokenEditor]);

  const handleAddRepo = useCallback(async () => {
    const draft = addRepoDraft.trim();
    if (!draft) return;
    const next = Array.from(new Set([...(status?.watchedRepos ?? []), draft])).sort();
    const res = await window.cerebro.github.setWatchedRepos(next);
    if (res.ok) {
      setAddRepoDraft('');
      await refreshStatus();
    }
  }, [addRepoDraft, status?.watchedRepos, refreshStatus]);

  const handleAddPicked = useCallback(async (fullName: string) => {
    const next = Array.from(new Set([...(status?.watchedRepos ?? []), fullName])).sort();
    const res = await window.cerebro.github.setWatchedRepos(next);
    if (res.ok) await refreshStatus();
  }, [status?.watchedRepos, refreshStatus]);

  const handleRemoveRepo = useCallback(async (fullName: string) => {
    const next = (status?.watchedRepos ?? []).filter((r) => r !== fullName);
    const res = await window.cerebro.github.setWatchedRepos(next);
    if (res.ok) await refreshStatus();
  }, [status?.watchedRepos, refreshStatus]);

  const tokenConfigured = Boolean(status?.hasToken);
  const showTokenInput = !tokenConfigured || editingToken;
  const usingKeychain = status?.tokenBackend === 'os-keychain';
  const watched = status?.watchedRepos ?? [];
  const watchedSet = new Set(watched);
  const pickable = accessibleRepos.filter((r) => !watchedSet.has(r.fullName)).slice(0, 10);

  return (
    <div>
      {showHeader && (
        <>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-zinc-500/15 text-text-primary">
              <GitHubIcon size={18} />
            </div>
            <h2 className="text-lg font-medium text-text-primary">{t('githubSection.title')}</h2>
          </div>
          <p className="text-sm text-text-secondary mt-3 leading-relaxed">
            {t('githubSection.description')}
          </p>
        </>
      )}

      {status && (
        usingKeychain ? (
          <div className="mt-4 flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-300">
            <Lock size={14} className="mt-0.5 flex-shrink-0" />
            <span className="leading-relaxed">{t('githubSection.storageEncrypted')}</span>
          </div>
        ) : (
          <div className="mt-4 flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-warning/30 bg-warning/10 text-xs text-warning-text">
            <ShieldAlert size={14} className="mt-0.5 flex-shrink-0" />
            <span className="leading-relaxed">{t('githubSection.storagePlaintextFallback')}</span>
          </div>
        )
      )}

      {/* Token row */}
      <div className="mt-6">
        <label className="text-xs font-medium text-text-secondary">{t('githubSection.tokenLabel')}</label>
        <p className="text-[11px] text-text-tertiary mt-1 leading-relaxed">{t('githubSection.tokenHelp')}</p>

        {showTokenInput ? (
          <>
            <div className="mt-2 flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  type={showToken ? 'text' : 'password'}
                  value={tokenDraft}
                  onChange={(e) => { setTokenDraft(e.target.value); setVerify({ kind: 'idle' }); }}
                  placeholder={t('githubSection.tokenPlaceholder')}
                  className="w-full bg-bg-surface border border-border-subtle rounded-md px-3 py-2 pr-10 text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() => setShowToken((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary"
                >
                  {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <button
                type="button"
                onClick={handleVerify}
                disabled={!tokenDraft.trim() || verify.kind === 'verifying'}
                className={clsx(
                  'px-3 py-2 text-sm rounded-md font-medium transition-colors',
                  'bg-accent/15 text-accent hover:bg-accent/25',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                )}
              >
                {verify.kind === 'verifying' ? t('githubSection.verifying') : t('githubSection.verify')}
              </button>
              {verify.kind === 'ok' && (
                <button
                  type="button"
                  onClick={handleSaveToken}
                  className="px-3 py-2 text-sm rounded-md font-medium bg-accent text-white hover:bg-accent-hover"
                >
                  {t('githubSection.save')}
                </button>
              )}
              {tokenConfigured && (
                <button
                  type="button"
                  onClick={resetTokenEditor}
                  className="px-3 py-2 text-sm rounded-md font-medium text-text-tertiary hover:text-text-secondary"
                >
                  {t('githubSection.cancel')}
                </button>
              )}
            </div>
            {verify.kind === 'ok' && (
              <div className="mt-2 flex items-center gap-1.5 text-xs text-emerald-400">
                <CheckCircle2 size={13} />
                <span>{t('githubSection.connectedAs', { login: verify.login ?? '?' })}</span>
              </div>
            )}
            {verify.kind === 'err' && (
              <div className="mt-2 flex items-center gap-1.5 text-xs text-red-400">
                <XCircle size={13} />
                <span>{verify.error}</span>
              </div>
            )}
          </>
        ) : (
          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-md bg-bg-surface border border-border-subtle text-sm">
              <Lock size={13} className="text-emerald-400/80 flex-shrink-0" />
              <span className="text-text-secondary">
                {status?.login
                  ? t('githubSection.connectedAs', { login: status.login })
                  : t('githubSection.notConnected')}
              </span>
            </div>
            <button
              type="button"
              onClick={() => { setEditingToken(true); setVerify({ kind: 'idle' }); }}
              className="px-3 py-2 text-sm rounded-md font-medium bg-accent/15 text-accent hover:bg-accent/25"
            >
              {t('githubSection.replaceToken')}
            </button>
            <button
              type="button"
              onClick={handleClearToken}
              className="px-3 py-2 text-sm rounded-md font-medium text-text-tertiary hover:text-red-400"
            >
              {t('githubSection.clearToken')}
            </button>
          </div>
        )}
      </div>

      {/* Watched repos */}
      {tokenConfigured && (
        <div className="mt-6">
          <label className="text-xs font-medium text-text-secondary">{t('githubSection.watchedReposLabel')}</label>
          <p className="text-[11px] text-text-tertiary mt-1 leading-relaxed">{t('githubSection.watchedReposHelp')}</p>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {watched.length === 0 && (
              <span className="text-xs text-text-tertiary">{t('githubSection.noRepos')}</span>
            )}
            {watched.map((r) => (
              <span
                key={r}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-mono bg-bg-surface border border-border-subtle"
              >
                {r}
                <button
                  type="button"
                  aria-label={t('githubSection.removeRepo')}
                  onClick={() => handleRemoveRepo(r)}
                  className="text-text-tertiary hover:text-red-400"
                >
                  <Trash2 size={11} />
                </button>
              </span>
            ))}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <input
              type="text"
              value={addRepoDraft}
              onChange={(e) => setAddRepoDraft(e.target.value)}
              placeholder={t('githubSection.addRepoPlaceholder')}
              className="flex-1 bg-bg-surface border border-border-subtle rounded-md px-3 py-1.5 text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
            />
            <button
              type="button"
              onClick={handleAddRepo}
              disabled={!addRepoDraft.trim()}
              className="px-3 py-1.5 text-sm rounded-md font-medium bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('githubSection.addRepo')}
            </button>
            <button
              type="button"
              onClick={refreshRepos}
              disabled={reposLoading}
              className="px-2 py-1.5 text-text-tertiary hover:text-text-secondary"
              aria-label={t('githubSection.refreshRepoList')}
            >
              {reposLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            </button>
          </div>

          {pickable.length > 0 && (
            <div className="mt-3">
              <p className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1.5">{t('githubSection.pickFromList')}</p>
              <div className="flex flex-wrap gap-1.5">
                {pickable.map((r) => (
                  <button
                    key={r.fullName}
                    type="button"
                    onClick={() => handleAddPicked(r.fullName)}
                    className="px-2 py-1 rounded-md text-xs font-mono bg-bg-surface border border-border-subtle hover:border-accent/50 text-text-secondary hover:text-text-primary"
                  >
                    {r.fullName}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Status row */}
      {status && tokenConfigured && (
        <div className="mt-6 grid grid-cols-3 gap-3 text-xs">
          <StatusCell
            label={watched.length > 0 ? t('githubSection.statusRunning') : t('githubSection.statusStopped')}
            value={watched.length > 0 ? `${watched.length} repo(s)` : '—'}
          />
          <StatusCell
            label={t('githubSection.lastPoll')}
            value={status.lastPollAt ? new Date(status.lastPollAt).toLocaleTimeString() : t('githubSection.never')}
          />
          <StatusCell
            label={t('githubSection.rateLimit')}
            value={status.rateLimitRemaining !== null
              ? t('githubSection.rateLimitRemaining', { remaining: status.rateLimitRemaining })
              : '—'}
          />
          {status.lastError && (
            <div className="col-span-3 flex items-start gap-1.5 text-red-400">
              <XCircle size={12} className="mt-0.5 flex-shrink-0" />
              <span>{status.lastError}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2 rounded-md bg-bg-surface border border-border-subtle">
      <div className="text-[10px] uppercase tracking-wider text-text-tertiary">{label}</div>
      <div className="mt-0.5 text-text-secondary">{value}</div>
    </div>
  );
}
