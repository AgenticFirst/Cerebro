import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Eye, EyeOff, Loader2, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { TelegramIcon } from '../../icons/BrandIcons';
import { loadSetting, saveSetting } from '../../../lib/settings';
import { TELEGRAM_SETTING_KEYS } from '../../../telegram/types';

type VerifyState =
  | { kind: 'idle' }
  | { kind: 'verifying' }
  | { kind: 'ok'; username: string }
  | { kind: 'err'; error: string };

export default function TelegramSection() {
  const { t } = useTranslation();

  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [allowlistRaw, setAllowlistRaw] = useState('');
  const [forwardAll, setForwardAll] = useState(false);
  const [enabled, setEnabled] = useState(false);

  const [verify, setVerify] = useState<VerifyState>({ kind: 'idle' });
  const [status, setStatus] = useState<{ running: boolean; lastPollAt: number | null; lastError: string | null } | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [enabling, setEnabling] = useState(false);

  // Initial load from settings.
  useEffect(() => {
    (async () => {
      const [tok, allowed, en, fwd] = await Promise.all([
        loadSetting<string>(TELEGRAM_SETTING_KEYS.token),
        loadSetting<string[]>(TELEGRAM_SETTING_KEYS.allowlist),
        loadSetting<boolean>(TELEGRAM_SETTING_KEYS.enabled),
        loadSetting<boolean>(TELEGRAM_SETTING_KEYS.forwardAllApprovals),
      ]);
      if (tok) setToken(tok);
      if (Array.isArray(allowed)) setAllowlistRaw(allowed.join(', '));
      if (typeof en === 'boolean') setEnabled(en);
      if (typeof fwd === 'boolean') setForwardAll(fwd);
    })();
  }, []);

  // Poll status while mounted. Skip setState when nothing changed so the
  // background 5s interval doesn't cause needless re-renders.
  const refreshStatus = useCallback(async () => {
    const s = await window.cerebro.telegram.status();
    setStatus((prev) => {
      if (
        prev
        && prev.running === s.running
        && prev.lastPollAt === s.lastPollAt
        && prev.lastError === s.lastError
      ) {
        return prev;
      }
      return { running: s.running, lastPollAt: s.lastPollAt, lastError: s.lastError };
    });
  }, []);

  useEffect(() => {
    refreshStatus();
    const id = setInterval(refreshStatus, 5_000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  // Parse allowlist string on demand.
  const parseAllowlist = useCallback((raw: string): string[] => {
    return raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s));
  }, []);

  const handleVerify = useCallback(async () => {
    if (!token.trim()) return;
    setVerify({ kind: 'verifying' });
    const res = await window.cerebro.telegram.verify(token.trim());
    if (res.ok && res.username) {
      setVerify({ kind: 'ok', username: res.username });
    } else {
      setVerify({ kind: 'err', error: res.error ?? 'Unknown error' });
    }
  }, [token]);

  const handleSave = useCallback(async () => {
    const list = parseAllowlist(allowlistRaw);
    saveSetting(TELEGRAM_SETTING_KEYS.token, token.trim());
    saveSetting(TELEGRAM_SETTING_KEYS.allowlist, list);
    saveSetting(TELEGRAM_SETTING_KEYS.forwardAllApprovals, forwardAll);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1_500);
  }, [token, allowlistRaw, forwardAll, parseAllowlist]);

  const canEnable =
    token.trim().length > 0
    && parseAllowlist(allowlistRaw).length > 0
    && (verify.kind === 'ok' || (enabled && status?.running));

  const handleToggleEnable = useCallback(async () => {
    setEnabling(true);
    try {
      // Save first so the bridge picks up the latest token/allowlist.
      await handleSave();
      const next = !enabled;
      saveSetting(TELEGRAM_SETTING_KEYS.enabled, next);
      setEnabled(next);
      if (next) {
        const res = await window.cerebro.telegram.enable();
        if (!res.ok) {
          // revert
          saveSetting(TELEGRAM_SETTING_KEYS.enabled, false);
          setEnabled(false);
        }
      } else {
        await window.cerebro.telegram.disable();
      }
      await refreshStatus();
    } finally {
      setEnabling(false);
    }
  }, [enabled, handleSave, refreshStatus]);

  const lastPollLabel = status?.lastPollAt
    ? new Date(status.lastPollAt).toLocaleTimeString()
    : t('telegramSection.never');

  return (
    <div>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-sky-500/15 text-sky-400">
          <TelegramIcon size={18} />
        </div>
        <h2 className="text-lg font-medium text-text-primary">{t('telegramSection.title')}</h2>
      </div>
      <p className="text-sm text-text-secondary mt-3 leading-relaxed">
        {t('telegramSection.description')}
      </p>

      {/* Warning banner */}
      <div className="mt-5 flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-warning/30 bg-warning/10 text-xs text-warning-text">
        <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
        <span className="leading-relaxed">{t('telegramSection.warningPlaintext')}</span>
      </div>

      {/* Token row */}
      <div className="mt-6">
        <label className="text-xs font-medium text-text-secondary">{t('telegramSection.tokenLabel')}</label>
        <div className="mt-1.5 flex items-center gap-2">
          <div className="relative flex-1">
            <input
              type={showToken ? 'text' : 'password'}
              value={token}
              onChange={(e) => { setToken(e.target.value); setVerify({ kind: 'idle' }); }}
              placeholder={t('telegramSection.tokenPlaceholder')}
              className="w-full bg-bg-surface border border-border-subtle rounded-md px-3 py-2 pr-10 text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary"
              aria-label={showToken ? 'Hide token' : 'Show token'}
            >
              {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <button
            type="button"
            onClick={handleVerify}
            disabled={!token.trim() || verify.kind === 'verifying'}
            className={clsx(
              'px-3 py-2 text-sm rounded-md font-medium transition-colors',
              'bg-accent/15 text-accent hover:bg-accent/25',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            {verify.kind === 'verifying' ? t('telegramSection.verifying') : t('telegramSection.verify')}
          </button>
        </div>
        {verify.kind === 'ok' && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-emerald-400">
            <CheckCircle2 size={13} />
            <span>@{verify.username}</span>
          </div>
        )}
        {verify.kind === 'err' && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-red-400">
            <XCircle size={13} />
            <span>{verify.error}</span>
          </div>
        )}
      </div>

      {/* How-to */}
      <details className="mt-5 bg-bg-surface border border-border-subtle rounded-md px-3 py-2.5 text-sm">
        <summary className="cursor-pointer text-text-secondary font-medium text-xs">
          {t('telegramSection.howToTitle')}
        </summary>
        <pre className="mt-2 text-xs text-text-secondary whitespace-pre-wrap font-sans leading-relaxed">
          {t('telegramSection.howToSteps')}
        </pre>
      </details>

      {/* Allowlist */}
      <div className="mt-6">
        <label className="text-xs font-medium text-text-secondary">{t('telegramSection.allowlistLabel')}</label>
        <input
          type="text"
          value={allowlistRaw}
          onChange={(e) => setAllowlistRaw(e.target.value)}
          placeholder={t('telegramSection.allowlistPlaceholder')}
          className="mt-1.5 w-full bg-bg-surface border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
          spellCheck={false}
        />
        <p className="mt-1.5 text-[11px] text-text-tertiary leading-relaxed">
          {t('telegramSection.allowlistHelp')}
        </p>
      </div>

      {/* Forward-all toggle */}
      <div className="mt-6 flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-sm text-text-primary">{t('telegramSection.forwardAllLabel')}</div>
          <p className="text-[11px] text-text-tertiary mt-1 leading-relaxed">
            {t('telegramSection.forwardAllHelp')}
          </p>
        </div>
        <ToggleSwitch checked={forwardAll} onChange={setForwardAll} />
      </div>

      {/* Save / saved */}
      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          className="px-3 py-1.5 text-xs rounded-md font-medium bg-bg-surface border border-border-subtle text-text-primary hover:bg-white/[0.04]"
        >
          {t('telegramSection.save')}
        </button>
        {savedFlash && <span className="text-xs text-emerald-400">{t('telegramSection.saved')}</span>}
      </div>

      {/* Enable bridge */}
      <div className="mt-6 bg-bg-surface border border-border-subtle rounded-lg p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="text-sm text-text-primary font-medium">{t('telegramSection.enableLabel')}</div>
            {!canEnable && !enabled && (
              <p className="text-[11px] text-text-tertiary mt-1 leading-relaxed">
                {t('telegramSection.enableDisabledHint')}
              </p>
            )}
            <div className="mt-2 flex items-center gap-2 text-xs">
              {enabling ? (
                <Loader2 size={13} className="text-amber-400 animate-spin" />
              ) : status?.running ? (
                <CheckCircle2 size={13} className="text-emerald-400" />
              ) : (
                <XCircle size={13} className="text-text-tertiary" />
              )}
              <span className={status?.running ? 'text-emerald-400' : 'text-text-tertiary'}>
                {status?.running ? t('telegramSection.statusRunning') : t('telegramSection.statusStopped')}
              </span>
              <span className="text-text-tertiary">•</span>
              <span className="text-text-tertiary">
                {t('telegramSection.lastPoll')}: {lastPollLabel}
              </span>
            </div>
            {status?.lastError && (
              <div className="mt-2 text-[11px] text-red-400 break-all">
                {t('telegramSection.lastError')}: {status.lastError}
              </div>
            )}
          </div>
          <ToggleSwitch
            checked={enabled}
            disabled={!canEnable && !enabled}
            onChange={handleToggleEnable}
          />
        </div>
      </div>
    </div>
  );
}

interface ToggleProps {
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}

function ToggleSwitch({ checked, disabled, onChange }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={clsx(
        'relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0',
        checked ? 'bg-accent' : 'bg-white/10',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      <span
        className={clsx(
          'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
        )}
      />
    </button>
  );
}
