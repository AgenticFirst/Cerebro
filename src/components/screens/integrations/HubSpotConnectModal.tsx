/**
 * Onboarding tour for first-time HubSpot setup. Walks the user through:
 *   1. Intro — what a Private App is and where to create it
 *   2. Visual click-by-click walkthrough through the HubSpot UI screens
 *      (powered by screenshots dropped in src/assets/hubspot-tour/)
 *   3. Paste & verify the token (encrypted in the OS keychain)
 *   4. Pick default ticket pipeline + stage
 *
 * Each step writes through the same IPC the HubSpotSection card uses, so
 * after closing the tour the inline editor reflects the saved state.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  Lightbulb,
  Loader2,
  Lock,
  ShieldAlert,
  Sparkles,
  Ticket,
  X,
  XCircle,
} from 'lucide-react';
import clsx from 'clsx';
import { Trans, useTranslation } from 'react-i18next';
import { HubSpotIcon } from '../../icons/BrandIcons';
import type { HubSpotPipelineSummary, HubSpotStatusResponse } from '../../../types/ipc';

type VerifyState =
  | { kind: 'idle' }
  | { kind: 'verifying' }
  | { kind: 'ok'; portalId: string | null }
  | { kind: 'err'; error: string };

interface HubSpotConnectModalProps {
  onClose: () => void;
  onPersisted?: () => void;
}

const STEP_COUNT = 4;

// HubSpot moved Private Apps under "Legacy Apps" — this short link redirects
// to the logged-in user's portal Legacy Apps page (works for any portal id).
const HUBSPOT_LEGACY_APPS_URL = 'https://app.hubspot.com/l/legacy-apps';

// The actual scope names HubSpot exposes today (verified in the Add Scope
// dialog). `tickets` is the single legacy scope covering both read+write —
// HubSpot doesn't split it the way contacts are split.
// Slugs are HubSpot-official identifiers and NOT translated — the `reasonKey`
// points at the localized explanation assembled inside the component.
const REQUIRED_SCOPES: Array<{ slug: string; reasonKey: string }> = [
  { slug: 'tickets', reasonKey: 'hubspotTour.scopeReasonTickets' },
  { slug: 'crm.objects.contacts.read', reasonKey: 'hubspotTour.scopeReasonContactsRead' },
  { slug: 'crm.objects.contacts.write', reasonKey: 'hubspotTour.scopeReasonContactsWrite' },
];

// ── Walkthrough screenshots ─────────────────────────────────────
//
// Drop the screenshots at these filenames under src/assets/hubspot-tour/
// and they show up automatically. If a file is missing, the step renders
// a placeholder so the tour still works.

const tourImageUrls = import.meta.glob<string>('../../../assets/hubspot-tour/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
});

function tourImage(filename: string): string | null {
  const match = Object.entries(tourImageUrls).find(([path]) => path.endsWith(`/${filename}`));
  return match ? match[1] : null;
}

interface WalkthroughScreen {
  imageFile: string;
  caption: string;
  hint: string;
}

// Screen order is fixed (matches screenshot filenames); caption + hint are
// built from translation keys inside the component.
const WALKTHROUGH_SCREENS: Array<{ imageFile: string; captionKey: string; hintKey: string }> = [
  { imageFile: '01-private-apps-moved.png', captionKey: 'hubspotTour.walk1Caption', hintKey: 'hubspotTour.walk1Hint' },
  { imageFile: '02-legacy-apps-empty.png',  captionKey: 'hubspotTour.walk2Caption', hintKey: 'hubspotTour.walk2Hint' },
  { imageFile: '03-create-modal-private.png', captionKey: 'hubspotTour.walk3Caption', hintKey: 'hubspotTour.walk3Hint' },
  { imageFile: '04-basic-info.png',         captionKey: 'hubspotTour.walk4Caption', hintKey: 'hubspotTour.walk4Hint' },
  { imageFile: '05-scopes-add.png',         captionKey: 'hubspotTour.walk5Caption', hintKey: 'hubspotTour.walk5Hint' },
  { imageFile: '06-confirm-create.png',     captionKey: 'hubspotTour.walk6Caption', hintKey: 'hubspotTour.walk6Hint' },
  { imageFile: '07-auth-token.png',         captionKey: 'hubspotTour.walk7Caption', hintKey: 'hubspotTour.walk7Hint' },
];

export default function HubSpotConnectModal({ onClose, onPersisted }: HubSpotConnectModalProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState(1);
  const [walkIndex, setWalkIndex] = useState(0);

  // Localized walkthrough — rebuilt when language changes.
  const WALKTHROUGH = useMemo<WalkthroughScreen[]>(
    () => WALKTHROUGH_SCREENS.map((s) => ({
      imageFile: s.imageFile,
      caption: t(s.captionKey),
      hint: t(s.hintKey),
    })),
    [t],
  );

  const [tokenDraft, setTokenDraft] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [verify, setVerify] = useState<VerifyState>({ kind: 'idle' });
  const [status, setStatus] = useState<HubSpotStatusResponse | null>(null);
  const [replaceTokenMode, setReplaceTokenMode] = useState(false);

  const [pipelines, setPipelines] = useState<HubSpotPipelineSummary[]>([]);
  const [pipelinesLoading, setPipelinesLoading] = useState(false);
  const [pipelineId, setPipelineId] = useState('');
  const [stageId, setStageId] = useState('');
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    const s = await window.cerebro.hubspot.status();
    setStatus(s);
    if (s.defaultPipeline && !pipelineId) setPipelineId(s.defaultPipeline);
    if (s.defaultStage && !stageId) setStageId(s.defaultStage);
  }, [pipelineId, stageId]);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  const loadPipelines = useCallback(async () => {
    setPipelinesLoading(true);
    const res = await window.cerebro.hubspot.listPipelines();
    setPipelinesLoading(false);
    if (res.ok && res.pipelines) setPipelines(res.pipelines);
  }, []);

  useEffect(() => {
    if (step === 4 && status?.hasToken && pipelines.length === 0) {
      void loadPipelines();
    }
  }, [step, status?.hasToken, pipelines.length, loadPipelines]);

  const handleVerify = useCallback(async () => {
    if (!tokenDraft.trim()) return;
    setVerify({ kind: 'verifying' });
    const res = await window.cerebro.hubspot.verify(tokenDraft.trim());
    if (res.ok) setVerify({ kind: 'ok', portalId: res.portalId ?? null });
    else setVerify({ kind: 'err', error: res.error ?? t('hubspotTour.step3UnknownError') });
  }, [tokenDraft, t]);

  const persistTokenAndAdvance = useCallback(async () => {
    if (verify.kind !== 'ok') return;
    const res = await window.cerebro.hubspot.setToken(tokenDraft.trim());
    if (!res.ok) {
      setVerify({ kind: 'err', error: res.error ?? t('hubspotTour.step3CouldNotStoreToken') });
      return;
    }
    onPersisted?.();
    await refreshStatus();
    setReplaceTokenMode(false);
    setTokenDraft('');
    setStep(4);
  }, [tokenDraft, verify, onPersisted, refreshStatus, t]);

  const handleSaveDefaults = useCallback(async () => {
    setSavingDefaults(true);
    setSaveError(null);
    try {
      const res = await window.cerebro.hubspot.setDefaults({
        pipeline: pipelineId || null,
        stage: stageId || null,
      });
      if (!res.ok) {
        setSaveError(res.error ?? t('hubspotTour.step4CouldNotSave'));
        return;
      }
      onPersisted?.();
      onClose();
    } finally {
      setSavingDefaults(false);
    }
  }, [pipelineId, stageId, onPersisted, onClose, t]);

  const openHubSpotPortal = useCallback(() => {
    void window.cerebro.shell.openExternal(HUBSPOT_LEGACY_APPS_URL);
  }, []);

  const copyScopes = useCallback(() => {
    const text = REQUIRED_SCOPES.map((s) => s.slug).join('\n');
    void navigator.clipboard?.writeText(text);
  }, []);

  const copyUrl = useCallback(() => {
    void navigator.clipboard?.writeText(HUBSPOT_LEGACY_APPS_URL);
  }, []);

  const draftReady = tokenDraft.trim().length > 0;
  const tokenAlreadyConfigured = Boolean(status?.hasToken);
  const showTokenForm = !tokenAlreadyConfigured || replaceTokenMode;
  const canAdvanceFromStep3 = showTokenForm ? verify.kind === 'ok' : true;
  const usingKeychain = status?.tokenBackend === 'os-keychain';
  const stagesForSelected = pipelines.find((p) => p.id === pipelineId)?.stages ?? [];

  const currentScreen = WALKTHROUGH[walkIndex];
  const currentScreenSrc = tourImage(currentScreen.imageFile);
  const isLastWalkScreen = walkIndex === WALKTHROUGH.length - 1;

  const stepIcon = useMemo(() => {
    switch (step) {
      case 1: return <Sparkles size={20} />;
      case 2: return <ExternalLink size={20} />;
      case 3: return <Lock size={20} />;
      case 4: return <Ticket size={20} />;
      default: return <HubSpotIcon size={20} />;
    }
  }, [step]);

  const advanceFromWalkthrough = useCallback(() => {
    if (isLastWalkScreen) setStep(3);
    else setWalkIndex((i) => i + 1);
  }, [isLastWalkScreen]);

  const goBackFromWalkthrough = useCallback(() => {
    if (walkIndex === 0) setStep(1);
    else setWalkIndex((i) => i - 1);
  }, [walkIndex]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-bg-surface border border-border-subtle rounded-xl shadow-2xl w-full max-w-2xl mx-4 animate-fade-in flex flex-col h-[min(720px,90vh)]">
        {/* Header */}
        <div className="px-6 pt-5 pb-4 border-b border-border-subtle">
          <button
            onClick={onClose}
            className="absolute top-3 right-3 p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
            aria-label={t('hubspotTour.closeAriaLabel')}
          >
            <X size={14} />
          </button>

          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-orange-500/15 text-orange-400 flex items-center justify-center flex-shrink-0">
              {stepIcon}
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
                {t('hubspotTour.stepCounter', { current: step, total: STEP_COUNT })}
                {step === 2 && (
                  <span className="ml-2 text-text-tertiary/70">
                    {t('hubspotTour.screenCounter', { current: walkIndex + 1, total: WALKTHROUGH.length })}
                  </span>
                )}
              </div>
              <h3 className="text-base font-medium text-text-primary mt-0.5 truncate">
                {step === 1 && t('hubspotTour.step1Title')}
                {step === 2 && t('hubspotTour.step2Title')}
                {step === 3 && t('hubspotTour.step3Title')}
                {step === 4 && t('hubspotTour.step4Title')}
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
                <Trans
                  i18nKey="hubspotTour.step1Body"
                  components={{ bold: <strong className="text-text-primary" /> }}
                />
              </p>

              <div className="rounded-md bg-amber-500/[0.08] border border-amber-500/30 p-3.5">
                <div className="flex items-center gap-2 text-xs font-semibold text-amber-300">
                  <Lightbulb size={13} />
                  {t('hubspotTour.step1WarningTitle')}
                </div>
                <p className="mt-2 text-xs text-amber-100/90 leading-relaxed">
                  {t('hubspotTour.step1WarningBody')}
                </p>
              </div>

              <ul className="space-y-2.5 text-sm text-text-secondary">
                <li className="flex gap-3">
                  <CheckCircle2 size={14} className="text-emerald-400 flex-shrink-0 mt-0.5" />
                  <span className="leading-relaxed">{t('hubspotTour.step1Bullet1')}</span>
                </li>
                <li className="flex gap-3">
                  <CheckCircle2 size={14} className="text-emerald-400 flex-shrink-0 mt-0.5" />
                  <span className="leading-relaxed">{t('hubspotTour.step1Bullet2')}</span>
                </li>
                <li className="flex gap-3">
                  <CheckCircle2 size={14} className="text-emerald-400 flex-shrink-0 mt-0.5" />
                  <span className="leading-relaxed">{t('hubspotTour.step1Bullet3')}</span>
                </li>
              </ul>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              {/* Open HubSpot button + URL — always visible so the chrome
                  doesn't change between walkthrough screens. */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={openHubSpotPortal}
                  className="flex items-center gap-2 px-3 py-2 rounded-md bg-orange-500/10 text-orange-400 hover:bg-orange-500/15 border border-orange-500/30 text-xs font-medium transition-colors flex-shrink-0"
                >
                  <ExternalLink size={12} />
                  {t('hubspotTour.openInBrowser')}
                </button>
                <div className="flex-1 flex items-center gap-2 px-2.5 py-2 rounded-md bg-bg-elevated border border-border-subtle min-w-0">
                  <code className="text-[11px] font-mono text-text-secondary truncate flex-1 select-all">
                    {HUBSPOT_LEGACY_APPS_URL}
                  </code>
                  <button
                    type="button"
                    onClick={copyUrl}
                    className="text-[11px] text-text-tertiary hover:text-text-secondary px-1.5 py-0.5 rounded hover:bg-white/5 flex-shrink-0"
                  >
                    {t('hubspotTour.copy')}
                  </button>
                </div>
              </div>

              {/* Walkthrough screen — fixed aspect ratio so the modal frame
                  doesn't resize between screenshots with different native sizes. */}
              <div className="rounded-md border border-border-subtle bg-white overflow-hidden aspect-[16/10] flex items-center justify-center">
                {currentScreenSrc ? (
                  <img
                    src={currentScreenSrc}
                    alt={currentScreen.caption}
                    className="max-w-full max-h-full object-contain"
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center text-center px-4 text-xs text-text-tertiary bg-bg-base w-full h-full">
                    <Lightbulb size={24} className="text-text-tertiary/60 mb-2" />
                    <div className="font-mono">{currentScreen.imageFile}</div>
                    <div className="mt-1 max-w-xs leading-relaxed">
                      <Trans
                        i18nKey="hubspotTour.placeholderDropFile"
                        values={{ filename: currentScreen.imageFile }}
                        components={{ code: <code className="text-text-secondary" /> }}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <div className="text-sm font-medium text-text-primary">{currentScreen.caption}</div>
                <p className="text-xs text-text-secondary leading-relaxed">{currentScreen.hint}</p>
              </div>

              {/* Walkthrough nav dots */}
              <div className="flex items-center justify-center gap-1.5">
                {WALKTHROUGH.map((_, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setWalkIndex(i)}
                    aria-label={t('hubspotTour.goToScreenAria', { number: i + 1 })}
                    className={clsx(
                      'h-1.5 rounded-full transition-all',
                      i === walkIndex ? 'w-5 bg-accent' : 'w-1.5 bg-white/15 hover:bg-white/30',
                    )}
                  />
                ))}
              </div>

              {/* Scopes reminder shown on the scopes screen */}
              {walkIndex === 4 && (
                <div className="rounded-md bg-accent/[0.06] border border-accent/20 p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs font-semibold text-accent">
                      <Lightbulb size={13} />
                      {t('hubspotTour.scopesToEnable')}
                    </div>
                    <button
                      type="button"
                      onClick={copyScopes}
                      className="text-[11px] text-accent/80 hover:text-accent px-1.5 py-0.5 rounded hover:bg-accent/10"
                    >
                      {t('hubspotTour.copyAll')}
                    </button>
                  </div>
                  <ul className="mt-3 space-y-2.5">
                    {REQUIRED_SCOPES.map((s) => (
                      <li key={s.slug} className="flex gap-2.5">
                        <CheckCircle2 size={12} className="text-accent/80 flex-shrink-0 mt-1" />
                        <div className="flex-1 min-w-0">
                          <code className="text-[11px] font-mono text-text-primary break-all">{s.slug}</code>
                          <p className="text-[11px] text-text-secondary mt-0.5 leading-relaxed">{t(s.reasonKey)}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              {!showTokenForm ? (
                <>
                  <p className="text-sm text-text-secondary leading-relaxed">
                    {t('hubspotTour.step3AlreadySavedBody')}
                  </p>
                  <div className="flex items-start gap-3 px-3 py-3 rounded-md border border-emerald-500/30 bg-emerald-500/10">
                    <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0 text-emerald-400" />
                    <div className="text-sm flex-1 min-w-0">
                      <div className="font-medium text-emerald-300">{t('hubspotTour.step3Connected')}</div>
                      {status?.portalId && (
                        <div className="text-xs text-emerald-300/80 mt-0.5 font-mono">
                          {t('hubspotTour.step3PortalLine', { portalId: status.portalId })}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => { setReplaceTokenMode(true); setTokenDraft(''); setVerify({ kind: 'idle' }); }}
                      className="text-xs font-medium text-text-tertiary hover:text-text-secondary px-2 py-1 rounded hover:bg-white/5"
                    >
                      {t('hubspotTour.step3ReplaceToken')}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm text-text-secondary leading-relaxed">
                    <Trans
                      i18nKey="hubspotTour.step3PasteBody"
                      components={{
                        bold: <strong className="text-text-primary" />,
                        code: <code className="px-1 py-0.5 rounded bg-bg-elevated text-[10px] font-mono" />,
                      }}
                    />
                  </p>
                  <div>
                    <label className="text-xs font-medium text-text-secondary">{t('hubspotTour.step3TokenLabel')}</label>
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="relative flex-1">
                        <input
                          type={showToken ? 'text' : 'password'}
                          value={tokenDraft}
                          onChange={(e) => { setTokenDraft(e.target.value); setVerify({ kind: 'idle' }); }}
                          placeholder={t('hubspotTour.step3TokenPlaceholder')}
                          className="w-full bg-bg-elevated border border-border-subtle rounded-md px-3 py-2 pr-10 text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
                          autoComplete="off"
                          spellCheck={false}
                          autoFocus
                        />
                        <button
                          type="button"
                          onClick={() => setShowToken((v) => !v)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary"
                          aria-label={showToken ? t('hubspotTour.step3HideToken') : t('hubspotTour.step3ShowToken')}
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
                        {verify.kind === 'verifying' ? t('hubspotTour.step3Verifying') : t('hubspotTour.step3Verify')}
                      </button>
                      {tokenAlreadyConfigured && (
                        <button
                          type="button"
                          onClick={() => { setReplaceTokenMode(false); setTokenDraft(''); setVerify({ kind: 'idle' }); }}
                          className="px-2 py-2 text-xs text-text-tertiary hover:text-text-secondary"
                        >
                          {t('hubspotTour.step3Cancel')}
                        </button>
                      )}
                    </div>
                    {verify.kind === 'ok' && (
                      <div className="mt-2 flex items-center gap-1.5 text-xs text-emerald-400">
                        <CheckCircle2 size={13} />
                        <span>
                          {t('hubspotTour.step3VerifiedPortal', { portalId: verify.portalId ?? t('hubspotTour.step3PortalHidden') })}
                        </span>
                      </div>
                    )}
                    {verify.kind === 'err' && (
                      <div className="mt-2 flex items-start gap-1.5 text-xs text-red-400">
                        <XCircle size={13} className="flex-shrink-0 mt-0.5" />
                        <span>{verify.error}</span>
                      </div>
                    )}
                  </div>
                  {status && (usingKeychain ? (
                    <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-300">
                      <Lock size={14} className="mt-0.5 flex-shrink-0" />
                      <span className="leading-relaxed">{t('hubspotTour.step3WillEncrypt')}</span>
                    </div>
                  ) : (
                    <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-warning/30 bg-warning/10 text-xs text-warning-text">
                      <ShieldAlert size={14} className="mt-0.5 flex-shrink-0" />
                      <span className="leading-relaxed">{t('hubspotTour.step3NoKeychain')}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4">
              <p className="text-sm text-text-secondary leading-relaxed">
                {t('hubspotTour.step4Body')}
              </p>
              {pipelinesLoading ? (
                <div className="flex items-center gap-2 text-xs text-text-tertiary">
                  <Loader2 size={12} className="animate-spin" /> {t('hubspotTour.step4Loading')}
                </div>
              ) : pipelines.length === 0 ? (
                <div className="flex items-start gap-2 px-3 py-2.5 rounded-md border border-amber-500/30 bg-amber-500/10 text-xs text-amber-200">
                  <Lightbulb size={13} className="mt-0.5 flex-shrink-0" />
                  <span className="leading-relaxed">
                    <Trans
                      i18nKey="hubspotTour.step4NoPipelinesPrefix"
                      components={{ code: <code className="mx-1 px-1 py-0.5 rounded bg-bg-elevated text-[10px]" /> }}
                    />
                    {' '}
                    <button type="button" onClick={loadPipelines} className="underline hover:no-underline">
                      {t('hubspotTour.step4TryAgain')}
                    </button>.
                  </span>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={pipelineId}
                    onChange={(e) => { setPipelineId(e.target.value); setStageId(''); }}
                    className="w-full h-9 px-3 text-sm bg-bg-elevated border border-border-subtle rounded-md text-text-primary focus:outline-none focus:border-accent/50"
                  >
                    <option value="">{t('hubspotTour.step4PipelinePlaceholder')}</option>
                    {pipelines.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                  <select
                    value={stageId}
                    onChange={(e) => setStageId(e.target.value)}
                    disabled={!pipelineId}
                    className="w-full h-9 px-3 text-sm bg-bg-elevated border border-border-subtle rounded-md text-text-primary focus:outline-none focus:border-accent/50 disabled:opacity-50"
                  >
                    <option value="">{t('hubspotTour.step4StagePlaceholder')}</option>
                    {stagesForSelected.map((s) => (
                      <option key={s.id} value={s.id}>{s.label}</option>
                    ))}
                  </select>
                </div>
              )}
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
              onClick={step === 2 ? goBackFromWalkthrough : () => setStep((s) => Math.max(1, s - 1))}
              className="px-3 py-1.5 text-xs font-medium rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors flex items-center gap-1.5"
            >
              <ArrowLeft size={12} /> {t('hubspotTour.back')}
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-medium rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              {t('hubspotTour.cancel')}
            </button>
          )}

          {step === 1 && (
            <button
              type="button"
              onClick={() => { setWalkIndex(0); setStep(2); }}
              className="px-4 py-1.5 text-xs font-medium rounded-md bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors flex items-center gap-1.5"
            >
              {t('hubspotTour.continue')} <ArrowRight size={12} />
            </button>
          )}
          {step === 2 && (
            <button
              type="button"
              onClick={advanceFromWalkthrough}
              className="px-4 py-1.5 text-xs font-medium rounded-md bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors flex items-center gap-1.5"
            >
              {isLastWalkScreen ? t('hubspotTour.iHaveToken') : t('hubspotTour.nextScreen')} <ArrowRight size={12} />
            </button>
          )}
          {step === 3 && (
            <button
              type="button"
              onClick={showTokenForm ? persistTokenAndAdvance : () => setStep(4)}
              disabled={!canAdvanceFromStep3}
              className="px-4 py-1.5 text-xs font-medium rounded-md bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('hubspotTour.continue')} <ArrowRight size={12} />
            </button>
          )}
          {step === 4 && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-xs font-medium rounded-md text-text-tertiary hover:text-text-secondary transition-colors"
              >
                {t('hubspotTour.skip')}
              </button>
              <button
                type="button"
                onClick={handleSaveDefaults}
                disabled={savingDefaults || !pipelineId || !stageId}
                className="px-4 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent-hover transition-colors flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {savingDefaults ? (
                  <><Loader2 size={12} className="animate-spin" /> {t('hubspotTour.saving')}</>
                ) : (
                  <><CheckCircle2 size={12} /> {t('hubspotTour.saveAndFinish')}</>
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
