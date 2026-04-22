/**
 * Onboarding tour for first-time Telegram setup. Walks the user through:
 *   1. Create a bot with @BotFather
 *   2. Paste & verify the token (encrypted at rest in the OS keychain)
 *   3. Allowlist Telegram user IDs
 *   4. Enable the bridge
 *
 * Each step persists through the same IPC + settings paths used by
 * TelegramSection, so when the user later opens the expandable card the values
 * are already populated and editable.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  ArrowLeft,
  Bot,
  CheckCircle2,
  Eye,
  EyeOff,
  ExternalLink,
  Lightbulb,
  Loader2,
  Lock,
  ShieldAlert,
  Sparkles,
  Users,
  X,
  XCircle,
} from 'lucide-react';
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

interface TelegramConnectModalProps {
  onClose: () => void;
  /** Called whenever a step persists state, so the parent can refresh its view. */
  onPersisted?: () => void;
}

const STEP_COUNT = 4;

export default function TelegramConnectModal({ onClose, onPersisted }: TelegramConnectModalProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState(1);

  // Local state — written through to settings as the user advances.
  const [tokenDraft, setTokenDraft] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [verify, setVerify] = useState<VerifyState>({ kind: 'idle' });
  const [allowlistRaw, setAllowlistRaw] = useState('');
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);
  const [status, setStatus] = useState<TelegramStatusResponse | null>(null);
  // When a token already exists, step 2 short-circuits to a confirmation card
  // unless the user clicks "Replace" to swap it out.
  const [replaceTokenMode, setReplaceTokenMode] = useState(false);

  // Pre-fill allowlist from existing settings (if the user is editing).
  useEffect(() => {
    void (async () => {
      const allowed = await loadSetting<string[]>(TELEGRAM_SETTING_KEYS.allowlist);
      if (Array.isArray(allowed) && allowed.length > 0) setAllowlistRaw(allowed.join(', '));
    })();
  }, []);

  const refreshStatus = useCallback(async () => {
    const s = await window.cerebro.telegram.status();
    setStatus(s);
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

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

  // Persist token only after a successful verify so we don't store junk.
  const persistTokenAndAdvance = useCallback(async () => {
    if (verify.kind !== 'ok') return;
    const res = await window.cerebro.telegram.setToken(tokenDraft.trim());
    if (!res.ok) {
      setVerify({ kind: 'err', error: res.error ?? 'Could not store token' });
      return;
    }
    onPersisted?.();
    await refreshStatus();
    setStep(3);
  }, [tokenDraft, verify, onPersisted, refreshStatus]);

  const persistAllowlistAndAdvance = useCallback(async () => {
    const list = parseAllowlist(allowlistRaw);
    saveSetting(TELEGRAM_SETTING_KEYS.allowlist, list);
    onPersisted?.();
    setStep(4);
  }, [allowlistRaw, parseAllowlist, onPersisted]);

  const handleEnable = useCallback(async () => {
    setEnabling(true);
    setEnableError(null);
    try {
      saveSetting(TELEGRAM_SETTING_KEYS.enabled, true);
      const res = await window.cerebro.telegram.enable();
      if (!res.ok) {
        saveSetting(TELEGRAM_SETTING_KEYS.enabled, false);
        setEnableError(res.error ?? t('telegramConnect.enableFailed'));
        return;
      }
      onPersisted?.();
      await refreshStatus();
      onClose();
    } finally {
      setEnabling(false);
    }
  }, [onPersisted, refreshStatus, onClose, t]);

  const openBotFather = useCallback(() => {
    window.open('https://t.me/BotFather', '_blank', 'noopener,noreferrer');
  }, []);

  const openUserInfoBot = useCallback(() => {
    window.open('https://t.me/userinfobot', '_blank', 'noopener,noreferrer');
  }, []);

  const draftReady = tokenDraft.trim().length > 0;
  const allowlistCount = parseAllowlist(allowlistRaw).length;
  const usingKeychain = status?.tokenBackend === 'os-keychain';
  const tokenAlreadyConfigured = Boolean(status?.hasToken);
  const showTokenForm = !tokenAlreadyConfigured || replaceTokenMode;
  const canAdvanceFromStep2 = showTokenForm ? verify.kind === 'ok' : true;

  const stepIcon = useMemo(() => {
    switch (step) {
      case 1: return <Sparkles size={20} />;
      case 2: return <Bot size={20} />;
      case 3: return <Users size={20} />;
      case 4: return <CheckCircle2 size={20} />;
      default: return <TelegramIcon size={20} />;
    }
  }, [step]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-bg-surface border border-border-subtle rounded-xl shadow-2xl w-full max-w-lg mx-4 animate-fade-in flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="px-6 pt-5 pb-4 border-b border-border-subtle">
          <button
            onClick={onClose}
            className="absolute top-3 right-3 p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
            aria-label={t('common.cancel')}
          >
            <X size={14} />
          </button>

          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-sky-500/15 text-sky-400 flex items-center justify-center flex-shrink-0">
              {stepIcon}
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
                {t('telegramConnect.stepLabel', { current: step, total: STEP_COUNT })}
              </div>
              <h3 className="text-base font-medium text-text-primary mt-0.5 truncate">
                {step === 1 && t('telegramConnect.step1Title')}
                {step === 2 && t('telegramConnect.step2Title')}
                {step === 3 && t('telegramConnect.step3Title')}
                {step === 4 && t('telegramConnect.step4Title')}
              </h3>
            </div>
          </div>

          {/* Step dots */}
          <div className="mt-4 flex items-center gap-1.5">
            {Array.from({ length: STEP_COUNT }).map((_, i) => (
              <div
                key={i}
                className={clsx(
                  'h-1 rounded-full transition-all',
                  i + 1 < step && 'flex-1 bg-accent/70',
                  i + 1 === step && 'flex-[2] bg-accent',
                  i + 1 > step && 'flex-1 bg-white/10',
                )}
              />
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5 overflow-y-auto flex-1">
          {step === 1 && (
            <div className="space-y-4">
              <p className="text-sm text-text-secondary leading-relaxed">
                {t('telegramConnect.step1Body')}
              </p>
              <ol className="space-y-2.5 text-sm text-text-secondary">
                {[1, 2, 3, 4].map((n) => (
                  <li key={n} className="flex gap-3">
                    <span className="w-5 h-5 rounded-full bg-accent/15 text-accent text-[11px] font-semibold flex items-center justify-center flex-shrink-0 mt-0.5">
                      {n}
                    </span>
                    <span className="leading-relaxed">{t(`telegramConnect.step1Item${n}`)}</span>
                  </li>
                ))}
              </ol>
              <button
                type="button"
                onClick={openBotFather}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-md bg-sky-500/10 text-sky-400 hover:bg-sky-500/15 border border-sky-500/30 text-sm font-medium transition-colors"
              >
                <ExternalLink size={14} />
                {t('telegramConnect.openBotFather')}
              </button>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              {!showTokenForm ? (
                <>
                  <p className="text-sm text-text-secondary leading-relaxed">
                    {t('telegramConnect.step2AlreadyConfiguredBody')}
                  </p>
                  <div className="flex items-start gap-3 px-3 py-3 rounded-md border border-emerald-500/30 bg-emerald-500/10">
                    <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0 text-emerald-400" />
                    <div className="text-sm flex-1 min-w-0">
                      <div className="font-medium text-emerald-300">
                        {t('telegramConnect.step2AlreadyConfiguredTitle')}
                      </div>
                      {status?.botUsername && (
                        <div className="text-xs text-emerald-300/80 mt-0.5 font-mono">
                          @{status.botUsername}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => { setReplaceTokenMode(true); setTokenDraft(''); setVerify({ kind: 'idle' }); }}
                      className="text-xs font-medium text-text-tertiary hover:text-text-secondary px-2 py-1 rounded hover:bg-white/5"
                    >
                      {t('telegramSection.replaceToken')}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm text-text-secondary leading-relaxed">
                    {t('telegramConnect.step2Body')}
                  </p>
                  <div>
                    <label className="text-xs font-medium text-text-secondary">
                      {t('telegramSection.tokenLabel')}
                    </label>
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="relative flex-1">
                        <input
                          type={showToken ? 'text' : 'password'}
                          value={tokenDraft}
                          onChange={(e) => { setTokenDraft(e.target.value); setVerify({ kind: 'idle' }); }}
                          placeholder={t('telegramSection.tokenPlaceholder')}
                          className="w-full bg-bg-elevated border border-border-subtle rounded-md px-3 py-2 pr-10 text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
                          autoComplete="off"
                          spellCheck={false}
                          autoFocus
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
                        disabled={!draftReady || verify.kind === 'verifying' || verify.kind === 'ok'}
                        className={clsx(
                          'px-3 py-2 text-sm rounded-md font-medium transition-colors',
                          'bg-accent/15 text-accent hover:bg-accent/25',
                          'disabled:opacity-50 disabled:cursor-not-allowed',
                        )}
                      >
                        {verify.kind === 'verifying' ? t('telegramSection.verifying') : t('telegramSection.verify')}
                      </button>
                      {tokenAlreadyConfigured && (
                        <button
                          type="button"
                          onClick={() => { setReplaceTokenMode(false); setTokenDraft(''); setVerify({ kind: 'idle' }); }}
                          className="px-2 py-2 text-xs text-text-tertiary hover:text-text-secondary"
                        >
                          {t('telegramSection.cancel')}
                        </button>
                      )}
                    </div>
                    {verify.kind === 'ok' && (
                      <div className="mt-2 flex items-center gap-1.5 text-xs text-emerald-400">
                        <CheckCircle2 size={13} />
                        <span>{t('telegramConnect.verifiedAs', { username: verify.username })}</span>
                      </div>
                    )}
                    {verify.kind === 'err' && (
                      <div className="mt-2 flex items-center gap-1.5 text-xs text-red-400">
                        <XCircle size={13} />
                        <span>{verify.error}</span>
                      </div>
                    )}
                  </div>
                  {status && (usingKeychain ? (
                    <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-300">
                      <Lock size={14} className="mt-0.5 flex-shrink-0" />
                      <span className="leading-relaxed">{t('telegramSection.storageEncrypted')}</span>
                    </div>
                  ) : (
                    <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-warning/30 bg-warning/10 text-xs text-warning-text">
                      <ShieldAlert size={14} className="mt-0.5 flex-shrink-0" />
                      <span className="leading-relaxed">{t('telegramSection.storagePlaintextFallback')}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <p className="text-sm text-text-secondary leading-relaxed">
                {t('telegramConnect.step3Body')}
              </p>
              <div>
                <label className="text-xs font-medium text-text-secondary">
                  {t('telegramSection.allowlistLabel')}
                </label>
                <input
                  type="text"
                  value={allowlistRaw}
                  onChange={(e) => setAllowlistRaw(e.target.value)}
                  placeholder={t('telegramSection.allowlistPlaceholder')}
                  className="mt-1.5 w-full bg-bg-elevated border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
                  spellCheck={false}
                  autoFocus
                />
                {allowlistCount > 0 && (
                  <div className="mt-1.5 flex items-center gap-1.5 text-xs text-emerald-400">
                    <CheckCircle2 size={13} />
                    <span>{t('telegramConnect.allowlistCount', { count: allowlistCount })}</span>
                  </div>
                )}
              </div>
              <div className="rounded-md bg-accent/[0.06] border border-accent/20 p-3.5">
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
                        onClick={openUserInfoBot}
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
                        {t('telegramConnect.step3HintOption2')}
                      </p>
                    </div>
                  </li>
                </ol>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4">
              {allowlistCount === 0 ? (
                <div className="flex items-start gap-3 px-3 py-3 rounded-md border border-amber-500/30 bg-amber-500/10">
                  <Lightbulb size={16} className="mt-0.5 flex-shrink-0 text-amber-400" />
                  <div className="text-xs leading-relaxed text-amber-100/90">
                    <div className="font-medium mb-1 text-sm text-amber-300">{t('telegramConnect.step4DiscoveryTitle')}</div>
                    <div>{t('telegramConnect.step4DiscoveryBody')}</div>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-text-secondary leading-relaxed">
                  {t('telegramConnect.step4Body')}
                </p>
              )}
              <div className="space-y-2 px-3 py-3 rounded-md bg-bg-elevated border border-border-subtle text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-text-tertiary text-xs">{t('telegramSection.botLabel')}</span>
                  <span className="font-mono text-text-primary text-xs">
                    {status?.botUsername ? `@${status.botUsername}` : (verify.kind === 'ok' ? `@${verify.username}` : '—')}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-text-tertiary text-xs">{t('telegramSection.allowlistLabel')}</span>
                  <span className="font-mono text-text-primary text-xs">
                    {allowlistCount > 0 ? t('telegramConnect.allowlistCount', { count: allowlistCount }) : t('common.none')}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-text-tertiary text-xs">{t('telegramConnect.storageLabel')}</span>
                  <span className="text-xs flex items-center gap-1.5">
                    {usingKeychain ? (
                      <><Lock size={11} className="text-emerald-400" /><span className="text-emerald-400">{t('telegramConnect.storageKeychain')}</span></>
                    ) : (
                      <><ShieldAlert size={11} className="text-warning-text" /><span className="text-warning-text">{t('telegramConnect.storagePlaintext')}</span></>
                    )}
                  </span>
                </div>
              </div>
              {enableError && (
                <div className="flex items-start gap-2 px-3 py-2.5 rounded-md border border-red-500/30 bg-red-500/10 text-xs text-red-400">
                  <XCircle size={13} className="mt-0.5 flex-shrink-0" />
                  <span className="leading-relaxed">{enableError}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border-subtle px-6 py-3 flex items-center justify-between gap-2">
          {step > 1 ? (
            <button
              type="button"
              onClick={() => setStep((s) => Math.max(1, s - 1))}
              className="px-3 py-1.5 text-xs font-medium rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors flex items-center gap-1.5"
            >
              <ArrowLeft size={12} /> {t('telegramConnect.back')}
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-medium rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              {t('common.cancel')}
            </button>
          )}

          {step === 1 && (
            <button
              type="button"
              onClick={() => setStep(2)}
              className="px-4 py-1.5 text-xs font-medium rounded-md bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors flex items-center gap-1.5"
            >
              {t('telegramConnect.continue')} <ArrowRight size={12} />
            </button>
          )}
          {step === 2 && (
            <button
              type="button"
              onClick={showTokenForm ? persistTokenAndAdvance : () => setStep(3)}
              disabled={!canAdvanceFromStep2}
              className="px-4 py-1.5 text-xs font-medium rounded-md bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('telegramConnect.continue')} <ArrowRight size={12} />
            </button>
          )}
          {step === 3 && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => { saveSetting(TELEGRAM_SETTING_KEYS.allowlist, []); onPersisted?.(); setStep(4); }}
                className="px-3 py-1.5 text-xs font-medium rounded-md text-text-tertiary hover:text-text-secondary transition-colors"
              >
                {t('telegramConnect.skip')}
              </button>
              <button
                type="button"
                onClick={persistAllowlistAndAdvance}
                disabled={allowlistCount === 0}
                className="px-4 py-1.5 text-xs font-medium rounded-md bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t('telegramConnect.continue')} <ArrowRight size={12} />
              </button>
            </div>
          )}
          {step === 4 && (
            <button
              type="button"
              onClick={handleEnable}
              disabled={enabling}
              className="px-4 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent-hover transition-colors flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {enabling
                ? (<><Loader2 size={12} className="animate-spin" /> {t('telegramConnect.enabling')}</>)
                : (
                  <>
                    <CheckCircle2 size={12} />
                    {allowlistCount === 0
                      ? t('telegramConnect.enableDiscoveryMode')
                      : t('telegramConnect.enableAndFinish')}
                  </>
                )
              }
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
