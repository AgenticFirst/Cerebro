import { useState, useEffect, useCallback } from 'react';
import { Cpu, CheckCircle2, XCircle, Loader2, ExternalLink, RefreshCw, LogIn } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { useProviders } from '../../../context/ProviderContext';
import { useEngine } from '../../../context/EngineContext';
import type { ClaudeCodeInfo } from '../../../types/providers';
import type { EngineId } from '../../../engines/types';
import type { CodexLoginSnapshot } from '../../../types/ipc';

export default function EngineSection() {
  const { t } = useTranslation();
  const { claudeCodeInfo, codexInfo, refreshClaudeCodeStatus, refreshCodexStatus } = useProviders();
  const { defaultEngine, setDefaultEngine } = useEngine();

  return (
    <div>
      <h2 className="text-lg font-medium text-text-primary">{t('engineSection.title')}</h2>
      <p className="text-sm text-text-secondary mt-1 leading-relaxed">
        {t('engineSection.description')}
      </p>

      {/* Active-engine picker */}
      <div className="mt-6">
        <div className="text-sm font-medium text-text-primary">{t('engineSection.activeEngine')}</div>
        <div className="text-xs text-text-secondary mb-2">{t('engineSection.activeEngineDesc')}</div>
        <div className="flex gap-2">
          <EngineRadio
            label={t('engineSection.claudeCode')}
            selected={defaultEngine === 'claude-code'}
            disabled={claudeCodeInfo.status !== 'available'}
            onSelect={() => setDefaultEngine('claude-code')}
          />
          <EngineRadio
            label={t('engineSection.codex')}
            selected={defaultEngine === 'codex'}
            disabled={codexInfo.status !== 'available'}
            onSelect={() => setDefaultEngine('codex')}
          />
        </div>
      </div>

      <div className="mt-6 space-y-4">
        <EngineCard
          engineId="claude-code"
          name={t('engineSection.claudeCode')}
          desc={t('engineSection.claudeCodeDesc')}
          info={claudeCodeInfo}
          onRefresh={refreshClaudeCodeStatus}
        />
        <EngineCard
          engineId="codex"
          name={t('engineSection.codex')}
          desc={t('engineSection.codexDesc')}
          info={codexInfo}
          onRefresh={refreshCodexStatus}
        />
      </div>
    </div>
  );
}

function EngineRadio({
  label,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      disabled={disabled}
      className={clsx(
        'px-3 py-1.5 rounded-md text-xs font-medium border transition-colors',
        disabled
          ? 'bg-bg-elevated text-text-tertiary border-border-subtle cursor-not-allowed opacity-60'
          : selected
            ? 'bg-accent/15 text-accent border-accent/40 cursor-pointer'
            : 'bg-bg-elevated text-text-secondary hover:text-text-primary hover:bg-bg-hover border-border-subtle cursor-pointer',
      )}
    >
      {label}
    </button>
  );
}

function EngineCard({
  engineId,
  name,
  desc,
  info,
  onRefresh,
}: {
  engineId: EngineId;
  name: string;
  desc: string;
  info: ClaudeCodeInfo;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { refreshCodexStatus } = useProviders();
  const [refreshing, setRefreshing] = useState(false);

  const status = info.status;
  const isAvailable = status === 'available';
  const isDetecting = status === 'detecting' || status === 'unknown';
  const isUnavailable = status === 'unavailable';
  const isError = status === 'error';

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-lg overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3.5">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-violet-500/15 text-violet-400">
          <Cpu size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-text-primary">{name}</div>
          <div className="text-xs text-text-secondary">{desc}</div>
        </div>
        <div className="flex items-center gap-2">
          {isAvailable && (
            <>
              <CheckCircle2 size={14} className="text-emerald-400" />
              <span className="text-xs text-emerald-400">{t('engineSection.detected')}</span>
            </>
          )}
          {isDetecting && (
            <>
              <Loader2 size={14} className="text-amber-400 animate-spin" />
              <span className="text-xs text-amber-400">{t('engineSection.detecting')}</span>
            </>
          )}
          {(isUnavailable || isError) && (
            <>
              <XCircle size={14} className="text-red-400" />
              <span className="text-xs text-red-400">
                {isUnavailable ? t('engineSection.notFound') : t('engineSection.error')}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="border-t border-border-subtle" />

      <div className="px-4 py-3.5 space-y-2">
        {isAvailable && (
          <>
            {info.version && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-text-tertiary">{t('engineSection.version')}</span>
                <code className="text-text-secondary font-mono">v{info.version}</code>
              </div>
            )}
            {info.path && (
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="text-text-tertiary flex-shrink-0">{t('engineSection.path')}</span>
                <code className="text-text-secondary font-mono truncate">{info.path}</code>
              </div>
            )}
          </>
        )}

        {(isUnavailable || isError) && (
          <div className="text-xs text-text-secondary leading-relaxed">
            <p className="mb-2">
              {t('engineSection.notFoundMessage')}{' '}
              {info.error && (
                <span className="text-red-400">{t('engineSection.notFoundError', { error: info.error })}</span>
              )}
            </p>
            {engineId === 'claude-code' ? (
              <p>
                {t('engineSection.installGuide')}{' '}
                <a
                  href="https://docs.claude.com/en/docs/claude-code/setup"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline inline-flex items-center gap-1"
                >
                  {t('engineSection.installGuideLink')}
                  <ExternalLink size={10} />
                </a>{' '}
                {t('engineSection.installGuideAfter')}
              </p>
            ) : (
              <p className="font-mono text-text-tertiary">npm install -g @openai/codex</p>
            )}
          </div>
        )}

        <div className="pt-2 flex items-center gap-2">
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className={clsx(
              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors',
              refreshing
                ? 'bg-bg-elevated text-text-tertiary border-border-subtle cursor-not-allowed'
                : 'bg-bg-elevated text-text-secondary hover:text-text-primary hover:bg-bg-hover border-border-subtle cursor-pointer',
            )}
          >
            <RefreshCw size={11} className={clsx(refreshing && 'animate-spin')} />
            {refreshing ? t('engineSection.detecting') : t('engineSection.redetect')}
          </button>

          {engineId === 'codex' && isAvailable && <CodexSignIn onDone={refreshCodexStatus} />}
        </div>
      </div>
    </div>
  );
}

/** Minimal in-app `codex login` button: starts the PTY OAuth flow, surfaces the
 *  captured sign-in URL, and reports success/failure. */
function CodexSignIn({ onDone }: { onDone: () => Promise<void> }) {
  const { t } = useTranslation();
  const [snap, setSnap] = useState<CodexLoginSnapshot | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const unsub = window.cerebro.codex.login.onEvent((s) => {
      setSnap(s);
      if (s.status === 'success') {
        void onDone();
        setBusy(false);
      } else if (s.status === 'failure' || s.status === 'cancelled') {
        setBusy(false);
      }
    });
    return unsub;
  }, [onDone]);

  const handleSignIn = useCallback(async () => {
    setBusy(true);
    try {
      const s = await window.cerebro.codex.login.start();
      setSnap(s);
    } catch {
      setBusy(false);
    }
  }, []);

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleSignIn}
        disabled={busy}
        className={clsx(
          'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors',
          busy
            ? 'bg-bg-elevated text-text-tertiary border-border-subtle cursor-not-allowed'
            : 'bg-bg-elevated text-text-secondary hover:text-text-primary hover:bg-bg-hover border-border-subtle cursor-pointer',
        )}
      >
        {busy ? <Loader2 size={11} className="animate-spin" /> : <LogIn size={11} />}
        {t('engineSection.signIn')}
      </button>
      {snap?.url && snap.status === 'awaiting-user' && (
        <a
          href={snap.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline inline-flex items-center gap-1 text-xs"
        >
          {t('engineSection.openSignInLink')}
          <ExternalLink size={10} />
        </a>
      )}
      {snap?.status === 'success' && <CheckCircle2 size={14} className="text-emerald-400" />}
    </div>
  );
}
