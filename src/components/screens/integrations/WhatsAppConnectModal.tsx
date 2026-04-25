/**
 * Onboarding tour for first-time WhatsApp Business setup. Four steps:
 *   1. Branching choice — "Do you have WhatsApp Business?"
 *        · Yes        → step 2 = pre-pairing safety briefing
 *        · Not yet    → step 2 = create-a-business-account walkthrough
 *        · Already paired (shortcut, only if status.state === 'connected')
 *   2. See above — content depends on the step-1 choice.
 *   3. Scan QR. Pairing auto-starts on entry; auto-advances on 'connected'.
 *   4. Allowlist customer numbers + save.
 *
 * All persistence routes through the same window.cerebro.whatsapp.* IPC as
 * WhatsAppSection so the inline card reflects values set here (and vice versa)
 * once the parent remounts the card.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Lightbulb,
  Loader2,
  Lock,
  MessageCircle,
  QrCode,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import clsx from 'clsx';
import { WhatsAppIcon } from '../../icons/BrandIcons';
import { parseAllowlistRaw } from '../../../whatsapp/helpers';
import type { WhatsAppStatusResponse } from '../../../types/ipc';

type Step = 1 | 2 | 3 | 4;
type Path = 'yes' | 'no';

const STEP_COUNT = 4;

// Store listings — Apple search page + Google Play listing. Using search URLs
// keeps us correct even if Meta updates the app ID.
const APP_STORE_URL = 'https://apps.apple.com/app/whatsapp-business/id1386412985';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.whatsapp.w4b';

interface WhatsAppConnectModalProps {
  onClose: () => void;
  /** Called after allowlist / pairing state is persisted. */
  onPersisted?: () => void;
}

export default function WhatsAppConnectModal({ onClose, onPersisted }: WhatsAppConnectModalProps) {
  const { t } = useTranslation();

  const [step, setStep] = useState<Step>(1);
  const [path, setPath] = useState<Path | null>(null);
  const [status, setStatus] = useState<WhatsAppStatusResponse | null>(null);
  const [pairingStartError, setPairingStartError] = useState<string | null>(null);

  const [allowlistRaw, setAllowlistRaw] = useState('');
  const [allowAny, setAllowAny] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ── Status subscription ──────────────────────────────────────
  const refreshStatus = useCallback(async () => {
    const s = await window.cerebro.whatsapp.status();
    setStatus(s);
  }, []);

  useEffect(() => {
    void refreshStatus();
    const off = window.cerebro.whatsapp.onStatusChanged((s) => setStatus(s));
    return off;
  }, [refreshStatus]);

  // Start pairing the moment we land on Step 3 (unless already pairing/connected).
  useEffect(() => {
    if (step !== 3) return;
    const s = status?.state;
    if (s === 'pairing' || s === 'connecting' || s === 'connected') return;
    void (async () => {
      setPairingStartError(null);
      const res = await window.cerebro.whatsapp.startPairing();
      if (!res.ok) setPairingStartError(res.error ?? t('whatsappConnect.step3CouldNotStart'));
    })();
  }, [step, status?.state, t]);

  // Auto-advance to Step 4 once WhatsApp reports 'connected'. Small delay so the
  // user gets a beat to register the "Connected!" state before the UI flips.
  useEffect(() => {
    if (step === 3 && status?.state === 'connected') {
      const handle = setTimeout(() => setStep(4), 900);
      return () => clearTimeout(handle);
    }
  }, [step, status?.state]);

  // ── Close handler ────────────────────────────────────────────
  // If the user bails mid-pairing we cancel on the bridge so it isn't left
  // holding a QR socket. If they're already connected, we leave the session alone.
  const handleClose = useCallback(() => {
    if (status?.state === 'pairing') {
      void window.cerebro.whatsapp.cancelPairing();
    }
    onClose();
  }, [status?.state, onClose]);

  const restartPairing = useCallback(async () => {
    setPairingStartError(null);
    await window.cerebro.whatsapp.cancelPairing();
    const res = await window.cerebro.whatsapp.startPairing();
    if (!res.ok) setPairingStartError(res.error ?? t('whatsappConnect.step3CouldNotStart'));
  }, [t]);

  // ── Allowlist save ───────────────────────────────────────────
  const handleFinish = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const list = allowAny ? ['*'] : parseAllowlistRaw(allowlistRaw);
      const res = await window.cerebro.whatsapp.setAllowlist(list);
      if (!res.ok) {
        setSaveError(res.error ?? t('whatsappConnect.step4SaveError'));
        return;
      }
      onPersisted?.();
      onClose();
    } finally {
      setSaving(false);
    }
  }, [allowlistRaw, allowAny, onPersisted, onClose, t]);

  // ── Derived state ────────────────────────────────────────────
  const alreadyPaired = status?.state === 'connected';
  const allowlistCount = useMemo(
    () => (allowAny ? 0 : parseAllowlistRaw(allowlistRaw).length),
    [allowlistRaw, allowAny],
  );
  const usingKeychain = status?.credsBackend === 'os-keychain';

  // Step-2 title depends on which branch the user picked.
  const step2Title =
    path === 'no' ? t('whatsappConnect.step2NoTitle') : t('whatsappConnect.step2YesTitle');

  const stepIcon = useMemo(() => {
    switch (step) {
      case 1: return <Sparkles size={20} />;
      case 2: return path === 'no' ? <MessageCircle size={20} /> : <ShieldCheck size={20} />;
      case 3: return <QrCode size={20} />;
      case 4: return <Users size={20} />;
      default: return <WhatsAppIcon size={20} />;
    }
  }, [step, path]);

  const headerTitle = step === 2 ? step2Title : t(`whatsappConnect.step${step}Title`);

  // ── External link helpers (Electron shell, falls back to window.open) ──
  const openExternal = useCallback((url: string) => {
    if (window.cerebro?.shell?.openExternal) {
      void window.cerebro.shell.openExternal(url);
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={handleClose} />

      <div className="relative bg-bg-surface border border-border-subtle rounded-xl shadow-2xl w-full max-w-lg mx-4 animate-fade-in flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="px-6 pt-5 pb-4 border-b border-border-subtle">
          <button
            onClick={handleClose}
            className="absolute top-3 right-3 p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
            aria-label={t('whatsappConnect.cancel')}
          >
            <X size={14} />
          </button>

          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-500/15 text-emerald-400 flex items-center justify-center flex-shrink-0">
              {stepIcon}
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
                {t('whatsappConnect.stepLabel', { current: step, total: STEP_COUNT })}
              </div>
              <h3 className="text-base font-medium text-text-primary mt-0.5 truncate">
                {headerTitle}
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
                {t('whatsappConnect.step1Body')}
              </p>

              <div className="space-y-2">
                <ChoiceCard
                  icon={<CheckCircle2 size={16} className="text-emerald-400" />}
                  title={t('whatsappConnect.step1ChoiceYesTitle')}
                  description={t('whatsappConnect.step1ChoiceYesDesc')}
                  onClick={() => { setPath('yes'); setStep(2); }}
                />
                <ChoiceCard
                  icon={<MessageCircle size={16} className="text-emerald-400" />}
                  title={t('whatsappConnect.step1ChoiceNoTitle')}
                  description={t('whatsappConnect.step1ChoiceNoDesc')}
                  onClick={() => { setPath('no'); setStep(2); }}
                />
                {alreadyPaired && (
                  <ChoiceCard
                    icon={<Sparkles size={16} className="text-accent" />}
                    title={t('whatsappConnect.step1AlreadyPairedTitle')}
                    description={t('whatsappConnect.step1AlreadyPairedDesc')}
                    onClick={() => { setPath('yes'); setStep(4); }}
                    subtle
                  />
                )}
              </div>
            </div>
          )}

          {step === 2 && path === 'no' && (
            <div className="space-y-4">
              <p className="text-sm text-text-secondary leading-relaxed">
                {t('whatsappConnect.step2NoBody')}
              </p>

              <ol className="space-y-3">
                {[1, 2, 3, 4, 5].map((n) => (
                  <li key={n} className="flex gap-3">
                    <span className="w-5 h-5 rounded-full bg-emerald-500/15 text-emerald-400 text-[11px] font-semibold flex items-center justify-center flex-shrink-0 mt-0.5">
                      {n}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-text-primary">
                        {t(`whatsappConnect.step2NoItem${n}Title`)}
                      </div>
                      <p className="text-xs text-text-secondary mt-0.5 leading-relaxed">
                        {t(`whatsappConnect.step2NoItem${n}Body`)}
                      </p>
                      {n === 2 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => openExternal(APP_STORE_URL)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 border border-emerald-500/30 text-xs font-medium transition-colors"
                          >
                            <ExternalLink size={11} />
                            {t('whatsappConnect.step2NoOpenAppStore')}
                          </button>
                          <button
                            type="button"
                            onClick={() => openExternal(PLAY_STORE_URL)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 border border-emerald-500/30 text-xs font-medium transition-colors"
                          >
                            <ExternalLink size={11} />
                            {t('whatsappConnect.step2NoOpenPlayStore')}
                          </button>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>

              <div className="rounded-md bg-accent/[0.06] border border-accent/20 p-3.5">
                <div className="flex items-center gap-2 text-xs font-semibold text-accent">
                  <Sparkles size={13} />
                  {t('whatsappConnect.step2NoReadyTitle')}
                </div>
                <p className="mt-1.5 text-xs text-text-secondary leading-relaxed">
                  {t('whatsappConnect.step2NoReadyBody')}
                </p>
              </div>
            </div>
          )}

          {step === 2 && path === 'yes' && (
            <div className="space-y-4">
              <p className="text-sm text-text-secondary leading-relaxed">
                {t('whatsappConnect.step2YesBody')}
              </p>

              <div className="rounded-md bg-amber-500/[0.08] border border-amber-500/30 p-3.5">
                <div className="flex items-center gap-2 text-xs font-semibold text-amber-300">
                  <ShieldAlert size={13} />
                  {t('whatsappConnect.step2YesTipTitle')}
                </div>
                <p className="mt-2 text-xs text-amber-100/90 leading-relaxed">
                  {t('whatsappConnect.step2YesTipBody')}
                </p>
              </div>

              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary mb-2">
                  {t('whatsappConnect.step2YesChecklistTitle')}
                </div>
                <ul className="space-y-2">
                  {[1, 2, 3].map((n) => (
                    <li key={n} className="flex gap-3 text-sm text-text-secondary">
                      <CheckCircle2 size={14} className="text-emerald-400 flex-shrink-0 mt-0.5" />
                      <span className="leading-relaxed">
                        {t(`whatsappConnect.step2YesChecklist${n}`)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <p className="text-sm text-text-secondary leading-relaxed">
                {t('whatsappConnect.step3Body')}
              </p>

              <div className="rounded-lg border border-border-subtle bg-bg-elevated p-4 flex flex-col items-center">
                {status?.state === 'connected' ? (
                  <div className="w-[240px] h-[240px] rounded-md bg-emerald-500/10 border border-emerald-500/30 flex flex-col items-center justify-center text-emerald-300 gap-2">
                    <CheckCircle2 size={48} />
                    <span className="text-sm font-medium">{t('whatsappConnect.step3Connected')}</span>
                  </div>
                ) : status?.state === 'connecting' ? (
                  <div className="w-[240px] h-[240px] rounded-md bg-bg-surface border border-border-subtle flex flex-col items-center justify-center text-text-secondary gap-3">
                    <Loader2 size={36} className="animate-spin" />
                    <span className="text-sm">{t('whatsappConnect.step3Connecting')}</span>
                  </div>
                ) : status?.qr ? (
                  <img
                    src={status.qr}
                    alt={t('whatsappSection.qrAltText')}
                    className="w-[240px] h-[240px] rounded-md bg-white p-2"
                  />
                ) : status?.state === 'error' ? (
                  <div className="w-[240px] h-[240px] rounded-md bg-red-500/10 border border-red-500/30 flex flex-col items-center justify-center text-red-400 gap-2 px-4 text-center">
                    <XCircle size={36} />
                    <span className="text-sm font-medium">{t('whatsappConnect.step3Error')}</span>
                    <span className="text-[11px] text-red-300/80 leading-relaxed">
                      {t('whatsappConnect.step3ErrorHint')}
                    </span>
                  </div>
                ) : (
                  <div className="w-[240px] h-[240px] rounded-md bg-bg-surface border border-border-subtle flex items-center justify-center text-text-secondary gap-2">
                    <Loader2 size={14} className="animate-spin" />
                    <span className="text-xs">{t('whatsappConnect.step3WaitingForQr')}</span>
                  </div>
                )}

                {(status?.state === 'pairing' || status?.state === 'error') && (
                  <button
                    type="button"
                    onClick={restartPairing}
                    className="mt-3 inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover"
                  >
                    <Loader2 size={11} />
                    {t('whatsappConnect.step3Restart')}
                  </button>
                )}
              </div>

              {pairingStartError && (
                <div className="flex items-start gap-2 px-3 py-2.5 rounded-md border border-red-500/30 bg-red-500/10 text-xs text-red-400">
                  <XCircle size={13} className="mt-0.5 flex-shrink-0" />
                  <span className="leading-relaxed">{pairingStartError}</span>
                </div>
              )}

              {status && (usingKeychain ? (
                <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-300">
                  <Lock size={14} className="mt-0.5 flex-shrink-0" />
                  <span className="leading-relaxed">{t('whatsappSection.sessionKeychain')}</span>
                </div>
              ) : (
                <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-border-subtle bg-bg-elevated text-xs text-text-secondary">
                  <Lock size={14} className="mt-0.5 flex-shrink-0" />
                  <span className="leading-relaxed">{t('whatsappSection.sessionPlaintext')}</span>
                </div>
              ))}
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4">
              {!alreadyPaired && (
                <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-amber-500/30 bg-amber-500/10 text-xs text-amber-200">
                  <Lightbulb size={13} className="mt-0.5 flex-shrink-0" />
                  <span className="leading-relaxed">{t('whatsappConnect.step4NotConnectedYet')}</span>
                </div>
              )}

              <p className="text-sm text-text-secondary leading-relaxed">
                {t('whatsappConnect.step4Body')}
              </p>

              <div>
                <input
                  type="text"
                  value={allowlistRaw}
                  onChange={(e) => { setAllowlistRaw(e.target.value); setAllowAny(false); }}
                  placeholder={t('whatsappConnect.step4Placeholder')}
                  disabled={allowAny}
                  className="w-full bg-bg-elevated border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 disabled:opacity-50"
                  spellCheck={false}
                  autoFocus
                />
                {allowlistCount > 0 && (
                  <div className="mt-1.5 flex items-center gap-1.5 text-xs text-emerald-400">
                    <CheckCircle2 size={13} />
                    <span>{t('whatsappConnect.allowlistCount', { count: allowlistCount })}</span>
                  </div>
                )}
              </div>

              {/* Allow-any toggle */}
              <label
                className={clsx(
                  'flex items-start gap-3 px-3 py-2.5 rounded-md border cursor-pointer transition-colors',
                  allowAny
                    ? 'border-amber-500/40 bg-amber-500/10'
                    : 'border-border-subtle bg-bg-elevated hover:border-border-strong',
                )}
              >
                <input
                  type="checkbox"
                  checked={allowAny}
                  onChange={(e) => setAllowAny(e.target.checked)}
                  className="mt-1 accent-amber-500"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-text-primary">
                    {t('whatsappConnect.step4AllowAllToggle')}
                  </div>
                  <p className="text-[11px] text-text-tertiary mt-0.5 leading-relaxed">
                    {t('whatsappConnect.step4AllowAllBody')}
                  </p>
                </div>
              </label>

              {/* Summary */}
              <div className="space-y-2 px-3 py-3 rounded-md bg-bg-elevated border border-border-subtle text-sm">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                  {t('whatsappConnect.step4SummaryTitle')}
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-text-tertiary text-xs">{t('whatsappConnect.step4SummaryPhone')}</span>
                  <span className="font-mono text-text-primary text-xs">
                    {status?.phoneNumber ?? '—'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-text-tertiary text-xs">{t('whatsappConnect.step4SummaryAllowlist')}</span>
                  <span className="font-mono text-text-primary text-xs">
                    {allowAny
                      ? t('whatsappConnect.step4SummaryAllowAny')
                      : allowlistCount > 0
                        ? t('whatsappConnect.allowlistCount', { count: allowlistCount })
                        : t('whatsappConnect.step4NoneSet')}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-text-tertiary text-xs">{t('whatsappConnect.step4SummaryStorage')}</span>
                  <span className="text-xs flex items-center gap-1.5">
                    {usingKeychain ? (
                      <><Lock size={11} className="text-emerald-400" /><span className="text-emerald-400">{t('whatsappConnect.step4StorageKeychain')}</span></>
                    ) : (
                      <><Lock size={11} className="text-text-secondary" /><span className="text-text-secondary">{t('whatsappConnect.step4StoragePlaintext')}</span></>
                    )}
                  </span>
                </div>
              </div>

              {saveError && (
                <div className="flex items-start gap-2 px-3 py-2.5 rounded-md border border-red-500/30 bg-red-500/10 text-xs text-red-400">
                  <XCircle size={13} className="mt-0.5 flex-shrink-0" />
                  <span className="leading-relaxed">{saveError}</span>
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
              onClick={() => setStep((s) => Math.max(1, s - 1) as Step)}
              className="px-3 py-1.5 text-xs font-medium rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors flex items-center gap-1.5"
            >
              <ArrowLeft size={12} /> {t('whatsappConnect.back')}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleClose}
              className="px-3 py-1.5 text-xs font-medium rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              {t('whatsappConnect.cancel')}
            </button>
          )}

          {/* Step 1 has no Next button — the choice cards advance the flow. */}
          {step === 2 && (
            <button
              type="button"
              onClick={() => setStep(3)}
              className="px-4 py-1.5 text-xs font-medium rounded-md bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors flex items-center gap-1.5"
            >
              {path === 'no'
                ? t('whatsappConnect.step2NoContinue')
                : t('whatsappConnect.step2YesContinue')}
              <ArrowRight size={12} />
            </button>
          )}
          {step === 3 && (
            <button
              type="button"
              onClick={() => setStep(4)}
              disabled={status?.state !== 'connected'}
              className="px-4 py-1.5 text-xs font-medium rounded-md bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('whatsappConnect.continue')} <ArrowRight size={12} />
            </button>
          )}
          {step === 4 && (
            <button
              type="button"
              onClick={handleFinish}
              disabled={saving}
              className="px-4 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent-hover transition-colors flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {saving ? (
                <><Loader2 size={12} className="animate-spin" /> {t('whatsappConnect.saving')}</>
              ) : (
                <><CheckCircle2 size={12} /> {t('whatsappConnect.finish')}</>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ChoiceCard({
  icon,
  title,
  description,
  onClick,
  subtle,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  subtle?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'w-full text-left flex items-start gap-3 px-4 py-3 rounded-md border transition-colors group',
        subtle
          ? 'border-border-subtle bg-bg-elevated hover:border-accent/40 hover:bg-accent/5'
          : 'border-border-subtle bg-bg-elevated hover:border-emerald-500/40 hover:bg-emerald-500/5',
      )}
    >
      <div className="flex-shrink-0 mt-0.5">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text-primary">{title}</div>
        <p className="text-xs text-text-secondary mt-0.5 leading-relaxed">{description}</p>
      </div>
      <ChevronRight size={16} className="text-text-tertiary group-hover:text-text-secondary flex-shrink-0 mt-0.5" />
    </button>
  );
}
