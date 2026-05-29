/**
 * Onboarding tour for first-time Slack setup. Walks the user through:
 *   1. Copy the manifest YAML
 *   2. Create the Slack app from the manifest
 *   3. Install to the workspace and copy the bot token
 *   4. Generate the app-level token
 *   5. Verify both tokens
 *   6. Done
 *
 * Tokens are persisted via the same IPC path as SlackSection — the renderer
 * never sees the encrypted-at-rest blob.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  Loader2,
  Lock,
  ShieldAlert,
  Sparkles,
  X,
  XCircle,
} from 'lucide-react';
import clsx from 'clsx';
import { SlackIcon } from '../../icons/BrandIcons';
import { saveSetting } from '../../../lib/settings';
import { SLACK_SETTING_KEYS } from '../../../slack/types';
import type { SlackStatusResponse } from '../../../types/ipc';

type VerifyState =
  | { kind: 'idle' }
  | { kind: 'verifying' }
  | { kind: 'ok'; teamName: string; teamId?: string }
  | { kind: 'err'; error: string };

interface SlackConnectModalProps {
  onClose: () => void;
  onPersisted?: () => void;
}

const STEP_COUNT = 6;

export default function SlackConnectModal({ onClose, onPersisted }: SlackConnectModalProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState(1);

  const [manifestYaml, setManifestYaml] = useState<string>('');
  const [manifestCopied, setManifestCopied] = useState(false);

  const [botDraft, setBotDraft] = useState('');
  const [appDraft, setAppDraft] = useState('');
  const [showBot, setShowBot] = useState(false);
  const [showApp, setShowApp] = useState(false);

  const [verify, setVerify] = useState<VerifyState>({ kind: 'idle' });
  const [status, setStatus] = useState<SlackStatusResponse | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);

  // Load status + manifest on open.
  useEffect(() => {
    (async () => {
      const [s, m] = await Promise.all([
        window.cerebro.slack.status(),
        window.cerebro.slack.getManifest(),
      ]);
      setStatus(s);
      if (m.ok && m.yaml) setManifestYaml(m.yaml);
    })();
  }, []);

  const refreshStatus = useCallback(async () => {
    const s = await window.cerebro.slack.status();
    setStatus(s);
  }, []);

  const handleCopyManifest = useCallback(async () => {
    if (!manifestYaml) return;
    try {
      await navigator.clipboard.writeText(manifestYaml);
      setManifestCopied(true);
      setTimeout(() => setManifestCopied(false), 1_500);
    } catch {
      // ignore — user can still copy from textarea
    }
  }, [manifestYaml]);

  const handleVerifyAndSave = useCallback(async () => {
    if (!botDraft.trim() || !appDraft.trim()) return;
    setVerify({ kind: 'verifying' });
    const res = await window.cerebro.slack.verify(botDraft.trim(), appDraft.trim());
    if (!res.ok) {
      setVerify({ kind: 'err', error: res.error ?? t('slackConnect.step5VerifyFailed') });
      return;
    }
    // Persist immediately so the user can close mid-tour without losing work.
    const saveRes = await window.cerebro.slack.setTokens({
      botToken: botDraft.trim(),
      appToken: appDraft.trim(),
    });
    if (!saveRes.ok) {
      setVerify({ kind: 'err', error: saveRes.error ?? 'Save failed' });
      return;
    }
    setVerify({ kind: 'ok', teamName: res.teamName ?? '', teamId: res.teamId });
    setBotDraft('');
    setAppDraft('');
    onPersisted?.();
    await refreshStatus();
  }, [botDraft, appDraft, t, onPersisted, refreshStatus]);

  const handleEnableAndFinish = useCallback(async () => {
    setEnabling(true);
    setEnableError(null);
    try {
      await saveSetting(SLACK_SETTING_KEYS.enabled, true);
      const r = await window.cerebro.slack.enable();
      if (!r.ok) {
        setEnableError(r.error ?? t('slackConnect.enableFailed'));
        await saveSetting(SLACK_SETTING_KEYS.enabled, false);
        return;
      }
      await refreshStatus();
      onPersisted?.();
      onClose();
    } finally {
      setEnabling(false);
    }
  }, [refreshStatus, onPersisted, onClose, t]);

  const tokensReady = (status?.hasBotToken && status?.hasAppToken) || verify.kind === 'ok';
  const usingKeychain = status?.tokenBackend === 'os-keychain';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div
        className="bg-bg-base border border-border-subtle rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-purple-500/15 text-purple-400">
              <SlackIcon size={18} />
            </div>
            <div>
              <div className="text-sm font-semibold text-text-primary">{t('slackSection.title')}</div>
              <div className="text-[11px] text-text-tertiary">
                {t('slackConnect.stepLabel', { current: step, total: STEP_COUNT })}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-text-tertiary hover:text-text-primary rounded-md p-1"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex gap-1.5 px-5 py-3 border-b border-border-subtle bg-bg-surface/30">
          {Array.from({ length: STEP_COUNT }).map((_, i) => (
            <div
              key={i}
              className={clsx(
                'h-1 flex-1 rounded-full transition-colors',
                i + 1 <= step ? 'bg-accent' : 'bg-white/10',
              )}
            />
          ))}
        </div>

        {/* Storage banner */}
        {status && (
          <div className="px-5 pt-4">
            {usingKeychain ? (
              <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-300">
                <Lock size={14} className="mt-0.5 flex-shrink-0" />
                <span className="leading-relaxed">{t('telegramSection.storageEncrypted')}</span>
              </div>
            ) : (
              <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-warning/30 bg-warning/10 text-xs text-warning-text">
                <ShieldAlert size={14} className="mt-0.5 flex-shrink-0" />
                <span className="leading-relaxed">{t('telegramSection.storagePlaintextFallback')}</span>
              </div>
            )}
          </div>
        )}

        {/* Step body */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4">
          {step === 1 && (
            <>
              <h3 className="text-base font-semibold text-text-primary">{t('slackConnect.step1Title')}</h3>
              <p className="text-sm text-text-secondary leading-relaxed">{t('slackConnect.step1Body')}</p>
              <ol className="text-sm text-text-secondary space-y-1.5 list-decimal list-inside">
                <li>{t('slackConnect.step1Item1')}</li>
                <li>{t('slackConnect.step1Item2')}</li>
                <li>{t('slackConnect.step1Item3')}</li>
                <li>{t('slackConnect.step1Item4')}</li>
              </ol>
              <div className="mt-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-text-secondary">manifest.yaml</span>
                  <button
                    type="button"
                    onClick={handleCopyManifest}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md font-medium bg-accent/15 text-accent hover:bg-accent/25"
                  >
                    {manifestCopied ? <CheckCircle2 size={12} /> : <Copy size={12} />}
                    {manifestCopied ? t('slackConnect.copyManifestDone') : t('slackConnect.copyManifest')}
                  </button>
                </div>
                <textarea
                  value={manifestYaml}
                  readOnly
                  className="w-full h-56 bg-bg-surface border border-border-subtle rounded-md px-3 py-2 text-[11px] font-mono text-text-primary focus:outline-none focus:border-accent/50 resize-none"
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  const url = `https://api.slack.com/apps?new_app=1&manifest_yaml=${encodeURIComponent(manifestYaml)}`;
                  window.open(url, '_blank', 'noopener,noreferrer');
                }}
                disabled={!manifestYaml}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-md font-medium bg-purple-500/15 text-purple-400 hover:bg-purple-500/25 disabled:opacity-50"
              >
                <ExternalLink size={13} />
                {t('slackConnect.openSlackApps')}
              </button>
            </>
          )}

          {step === 2 && (
            <>
              <h3 className="text-base font-semibold text-text-primary">{t('slackConnect.step2Title')}</h3>
              <p className="text-sm text-text-secondary leading-relaxed">{t('slackConnect.step2Body')}</p>
            </>
          )}

          {step === 3 && (
            <>
              <h3 className="text-base font-semibold text-text-primary">{t('slackConnect.step3Title')}</h3>
              <p className="text-sm text-text-secondary leading-relaxed">{t('slackConnect.step3Body')}</p>
              <div>
                <label className="text-xs font-medium text-text-secondary">{t('slackConnect.botTokenLabel')}</label>
                <div className="mt-1.5 relative">
                  <input
                    type={showBot ? 'text' : 'password'}
                    value={botDraft}
                    onChange={(e) => { setBotDraft(e.target.value); setVerify({ kind: 'idle' }); }}
                    placeholder={t('slackConnect.botTokenPlaceholder')}
                    className="w-full bg-bg-surface border border-border-subtle rounded-md px-3 py-2 pr-10 text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => setShowBot((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary"
                    aria-label={showBot ? 'Hide' : 'Show'}
                  >
                    {showBot ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <h3 className="text-base font-semibold text-text-primary">{t('slackConnect.step4Title')}</h3>
              <p className="text-sm text-text-secondary leading-relaxed">{t('slackConnect.step4Body')}</p>
              <div>
                <label className="text-xs font-medium text-text-secondary">{t('slackConnect.appTokenLabel')}</label>
                <div className="mt-1.5 relative">
                  <input
                    type={showApp ? 'text' : 'password'}
                    value={appDraft}
                    onChange={(e) => { setAppDraft(e.target.value); setVerify({ kind: 'idle' }); }}
                    placeholder={t('slackConnect.appTokenPlaceholder')}
                    className="w-full bg-bg-surface border border-border-subtle rounded-md px-3 py-2 pr-10 text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => setShowApp((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary"
                    aria-label={showApp ? 'Hide' : 'Show'}
                  >
                    {showApp ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
            </>
          )}

          {step === 5 && (
            <>
              <h3 className="text-base font-semibold text-text-primary">{t('slackConnect.step5Title')}</h3>
              <p className="text-sm text-text-secondary leading-relaxed">{t('slackConnect.step5Body')}</p>
              <button
                type="button"
                onClick={handleVerifyAndSave}
                disabled={!botDraft.trim() || !appDraft.trim() || verify.kind === 'verifying'}
                className={clsx(
                  'px-3 py-2 text-sm rounded-md font-medium transition-colors',
                  'bg-accent/15 text-accent hover:bg-accent/25',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                  'inline-flex items-center gap-1.5',
                )}
              >
                {verify.kind === 'verifying' ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                {verify.kind === 'verifying' ? t('slackConnect.verifying') : t('slackConnect.verify')}
              </button>
              {verify.kind === 'ok' && (
                <div className="flex items-center gap-1.5 text-sm text-emerald-400">
                  <CheckCircle2 size={14} />
                  {t('slackConnect.verifiedAs', { teamName: verify.teamName })}
                </div>
              )}
              {verify.kind === 'err' && (
                <div className="flex items-start gap-1.5 text-sm text-red-400">
                  <XCircle size={14} className="mt-0.5" />
                  <span>{verify.error}</span>
                </div>
              )}
            </>
          )}

          {step === 6 && (
            <>
              <h3 className="text-base font-semibold text-text-primary">{t('slackConnect.step6Title')}</h3>
              <p className="text-sm text-text-secondary leading-relaxed">{t('slackConnect.step6Body')}</p>
              <p className="text-sm text-text-tertiary leading-relaxed">{t('slackConnect.setAllowlistLater')}</p>
              {enableError && (
                <div className="flex items-start gap-1.5 text-sm text-red-400">
                  <XCircle size={14} className="mt-0.5" />
                  <span>{enableError}</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-border-subtle">
          <button
            type="button"
            onClick={() => setStep((s) => Math.max(1, s - 1))}
            disabled={step === 1}
            className="px-3 py-2 text-sm rounded-md font-medium text-text-secondary hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
          >
            <ArrowLeft size={14} />
            {t('slackConnect.back')}
          </button>
          <div className="flex items-center gap-2">
            {step < STEP_COUNT && (
              <button
                type="button"
                onClick={() => setStep((s) => Math.min(STEP_COUNT, s + 1))}
                disabled={step === 5 && verify.kind !== 'ok' && !tokensReady}
                className={clsx(
                  'px-4 py-2 text-sm rounded-md font-medium transition-colors inline-flex items-center gap-1.5',
                  'bg-accent text-white hover:bg-accent-hover shadow-sm',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                )}
              >
                {t('slackConnect.continue')}
                <ArrowRight size={14} />
              </button>
            )}
            {step === STEP_COUNT && (
              <button
                type="button"
                onClick={handleEnableAndFinish}
                disabled={enabling}
                className="px-4 py-2 text-sm rounded-md font-medium bg-accent text-white hover:bg-accent-hover shadow-sm inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                {enabling ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                {enabling ? t('slackConnect.enabling') : t('slackConnect.enableAndFinish')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
