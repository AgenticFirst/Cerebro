import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, ExternalLink, Eye, EyeOff, Lightbulb, Loader2, Lock, ShieldAlert, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { TelegramIcon } from '../../icons/BrandIcons';
import { loadSetting, saveSetting } from '../../../lib/settings';
import { TELEGRAM_SETTING_KEYS } from '../../../telegram/types';
import type { TelegramStatusResponse } from '../../../types/ipc';

type VerifyState =
  | { kind: 'idle' }
  | { kind: 'verifying' }
  | { kind: 'ok'; username: string }
  | { kind: 'err'; error: string };

interface TelegramSectionProps {
  /** When true, render the section heading + description. Off by default so the
   *  component can be used inside an IntegrationCard which already owns the
   *  chrome. */
  showHeader?: boolean;
}

export default function TelegramSection({ showHeader = false }: TelegramSectionProps = {}) {
  const { t } = useTranslation();

  // `tokenDraft` is the in-memory edit buffer. It is never persisted from the
  // renderer — `setToken()` IPC encrypts it in the main process before writing.
  const [tokenDraft, setTokenDraft] = useState('');
  const [editingToken, setEditingToken] = useState(false);
  const [showToken, setShowToken] = useState(false);

  const [allowlistRaw, setAllowlistRaw] = useState('');
  const [forwardAll, setForwardAll] = useState(false);
  const [enabled, setEnabled] = useState(false);

  const [verify, setVerify] = useState<VerifyState>({ kind: 'idle' });
  const [status, setStatus] = useState<TelegramStatusResponse | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [enabling, setEnabling] = useState(false);

  // Initial load — note we do NOT load the token from settings; we only ask
  // status() whether one is configured. The plaintext lives in the main
  // process and is never sent back to the renderer.
  useEffect(() => {
    (async () => {
      const [allowed, en, fwd] = await Promise.all([
        loadSetting<string[]>(TELEGRAM_SETTING_KEYS.allowlist),
        loadSetting<boolean>(TELEGRAM_SETTING_KEYS.enabled),
        loadSetting<boolean>(TELEGRAM_SETTING_KEYS.forwardAllApprovals),
      ]);
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
        && prev.botUsername === s.botUsername
        && prev.hasToken === s.hasToken
        && prev.tokenBackend === s.tokenBackend
      ) {
        return prev;
      }
      return s;
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
    if (!tokenDraft.trim()) return;
    setVerify({ kind: 'verifying' });
    const res = await window.cerebro.telegram.verify(tokenDraft.trim());
    if (res.ok && res.username) {
      setVerify({ kind: 'ok', username: res.username });
    } else {
      setVerify({ kind: 'err', error: res.error ?? 'Unknown error' });
    }
  }, [tokenDraft]);

  const persistTokenIfDraft = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (!tokenDraft.trim()) return { ok: true };
    const res = await window.cerebro.telegram.setToken(tokenDraft.trim());
    if (res.ok) {
      setTokenDraft('');
      setEditingToken(false);
      setShowToken(false);
      setVerify({ kind: 'idle' });
    }
    return res;
  }, [tokenDraft]);

  const handleSave = useCallback(async () => {
    const list = parseAllowlist(allowlistRaw);
    const tokenRes = await persistTokenIfDraft();
    if (!tokenRes.ok) return;
    // Must await both writes before reload — otherwise the bridge re-reads
    // settings before the PUTs land and sees the stale allowlist.
    await Promise.all([
      saveSetting(TELEGRAM_SETTING_KEYS.allowlist, list),
      saveSetting(TELEGRAM_SETTING_KEYS.forwardAllApprovals, forwardAll),
    ]);
    if (enabled && status?.running) {
      await window.cerebro.telegram.reload();
    }
    await refreshStatus();
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1_500);
  }, [allowlistRaw, forwardAll, parseAllowlist, persistTokenIfDraft, enabled, status?.running, refreshStatus]);

  const handleClearToken = useCallback(async () => {
    await window.cerebro.telegram.clearToken();
    setTokenDraft('');
    setEditingToken(false);
    setShowToken(false);
    setVerify({ kind: 'idle' });
    await refreshStatus();
  }, [refreshStatus]);

  const tokenConfigured = Boolean(status?.hasToken);
  const draftReady = tokenDraft.trim().length > 0;
  const allowlistReady = parseAllowlist(allowlistRaw).length > 0;

  // The bridge can run without an allowlist — in that "discovery mode" it
  // only replies with sender IDs (rate-limited) so users can find their own.
  // We only require a verified token to flip the enable toggle.
  const canEnable =
    (enabled && status?.running)
    || (tokenConfigured && !editingToken)
    || (draftReady && verify.kind === 'ok');

  const handleToggleEnable = useCallback(async () => {
    setEnabling(true);
    try {
      const tokenRes = await persistTokenIfDraft();
      if (!tokenRes.ok) return;
      await Promise.all([
        saveSetting(TELEGRAM_SETTING_KEYS.allowlist, parseAllowlist(allowlistRaw)),
        saveSetting(TELEGRAM_SETTING_KEYS.forwardAllApprovals, forwardAll),
      ]);

      const next = !enabled;
      await saveSetting(TELEGRAM_SETTING_KEYS.enabled, next);
      setEnabled(next);
      if (next) {
        const res = await window.cerebro.telegram.enable();
        if (!res.ok) {
          await saveSetting(TELEGRAM_SETTING_KEYS.enabled, false);
          setEnabled(false);
        }
      } else {
        await window.cerebro.telegram.disable();
      }
      await refreshStatus();
    } finally {
      setEnabling(false);
    }
  }, [enabled, persistTokenIfDraft, allowlistRaw, parseAllowlist, forwardAll, refreshStatus]);

  const lastPollLabel = status?.lastPollAt
    ? new Date(status.lastPollAt).toLocaleTimeString()
    : t('telegramSection.never');

  const showTokenInput = !tokenConfigured || editingToken;
  const usingKeychain = status?.tokenBackend === 'os-keychain';

  return (
    <div>
      {showHeader && (
        <>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-sky-500/15 text-sky-400">
              <TelegramIcon size={18} />
            </div>
            <h2 className="text-lg font-medium text-text-primary">{t('telegramSection.title')}</h2>
          </div>
          <p className="text-sm text-text-secondary mt-3 leading-relaxed">
            {t('telegramSection.description')}
          </p>
        </>
      )}

      {/* Storage status banner — green when encrypted, amber when falling back to plaintext. */}
      {status && (
        usingKeychain ? (
          <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-300">
            <Lock size={14} className="mt-0.5 flex-shrink-0" />
            <span className="leading-relaxed">{t('telegramSection.storageEncrypted')}</span>
          </div>
        ) : (
          <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-warning/30 bg-warning/10 text-xs text-warning-text">
            <ShieldAlert size={14} className="mt-0.5 flex-shrink-0" />
            <span className="leading-relaxed">{t('telegramSection.storagePlaintextFallback')}</span>
          </div>
        )
      )}

      {/* Token row */}
      <div className="mt-6">
        <label className="text-xs font-medium text-text-secondary">{t('telegramSection.tokenLabel')}</label>

        {showTokenInput ? (
          <>
            <div className="mt-1.5 flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  type={showToken ? 'text' : 'password'}
                  value={tokenDraft}
                  onChange={(e) => { setTokenDraft(e.target.value); setVerify({ kind: 'idle' }); }}
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
                disabled={!draftReady || verify.kind === 'verifying'}
                className={clsx(
                  'px-3 py-2 text-sm rounded-md font-medium transition-colors',
                  'bg-accent/15 text-accent hover:bg-accent/25',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                )}
              >
                {verify.kind === 'verifying' ? t('telegramSection.verifying') : t('telegramSection.verify')}
              </button>
              {tokenConfigured && (
                <button
                  type="button"
                  onClick={() => { setTokenDraft(''); setEditingToken(false); setShowToken(false); setVerify({ kind: 'idle' }); }}
                  className="px-3 py-2 text-sm rounded-md font-medium text-text-tertiary hover:text-text-secondary"
                >
                  {t('telegramSection.cancel')}
                </button>
              )}
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
          </>
        ) : (
          <div className="mt-1.5 flex items-center gap-2">
            <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-md bg-bg-surface border border-border-subtle text-sm">
              <Lock size={13} className="text-emerald-400/80 flex-shrink-0" />
              <span className="text-text-secondary">{t('telegramSection.tokenStored')}</span>
            </div>
            <button
              type="button"
              onClick={() => { setEditingToken(true); setVerify({ kind: 'idle' }); }}
              className="px-3 py-2 text-sm rounded-md font-medium bg-accent/15 text-accent hover:bg-accent/25"
            >
              {t('telegramSection.replaceToken')}
            </button>
            <button
              type="button"
              onClick={handleClearToken}
              className="px-3 py-2 text-sm rounded-md font-medium text-text-tertiary hover:text-red-400"
            >
              {t('telegramSection.clearToken')}
            </button>
          </div>
        )}
      </div>

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

        {/* Crystal-clear "how to find your ID" panel */}
        <div className="mt-3 rounded-md bg-accent/[0.06] border border-accent/20 p-3.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-accent">
            <Lightbulb size={13} />
            {t('telegramConnect.step3HintTitle')}
          </div>
          <ol className="mt-3 space-y-3">
            <li className="flex gap-2.5">
              <span className="w-5 h-5 rounded-full bg-accent/15 text-accent text-[11px] font-semibold flex items-center justify-center flex-shrink-0 mt-0.5">
                1
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-medium uppercase tracking-wider text-accent/80">
                  {t('telegramConnect.step3HintOption1Label')}
                </div>
                <p className="text-xs text-text-secondary leading-relaxed mt-0.5">
                  {t('telegramConnect.step3HintOption1')}
                </p>
                <button
                  type="button"
                  onClick={() => window.open('https://t.me/userinfobot', '_blank', 'noopener,noreferrer')}
                  className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-sky-500/10 text-sky-400 hover:bg-sky-500/20 border border-sky-500/30 text-xs font-medium transition-colors"
                >
                  <ExternalLink size={11} />
                  {t('telegramConnect.openUserInfoBot')}
                </button>
              </div>
            </li>
            <li className="flex gap-2.5">
              <span className="w-5 h-5 rounded-full bg-accent/15 text-accent text-[11px] font-semibold flex items-center justify-center flex-shrink-0 mt-0.5">
                2
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-medium uppercase tracking-wider text-accent/80">
                  {t('telegramConnect.step3HintOption2Label')}
                </div>
                <p className="text-xs text-text-secondary leading-relaxed mt-0.5">
                  {t('telegramSection.allowlistHintOption2')}
                </p>
              </div>
            </li>
          </ol>
        </div>
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
      <div className="mt-5 flex items-center justify-end gap-3">
        {savedFlash && (
          <span className="text-sm text-emerald-400 flex items-center gap-1.5">
            <CheckCircle2 size={14} />
            {t('telegramSection.saved')}
          </span>
        )}
        <button
          type="button"
          onClick={handleSave}
          className="px-4 py-2 text-sm rounded-md font-medium bg-accent text-white hover:bg-accent-hover transition-colors flex items-center gap-1.5 shadow-sm"
        >
          <CheckCircle2 size={14} />
          {t('telegramSection.save')}
        </button>
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
            {canEnable && !allowlistReady && (
              <p className="text-[11px] text-amber-400/90 mt-1 leading-relaxed">
                {t('telegramSection.discoveryModeHint')}
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
            {status?.botUsername && (
              <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-text-tertiary">
                <TelegramIcon size={11} className="text-sky-400/70" />
                <span>{t('telegramSection.botLabel')}: <span className="font-mono text-text-secondary">@{status.botUsername}</span></span>
              </div>
            )}
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
