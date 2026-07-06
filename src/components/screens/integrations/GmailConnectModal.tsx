/**
 * Bring-your-own OAuth connect flow for Gmail:
 *   1. Walkthrough — create a Google Cloud project, enable the Gmail API,
 *      create a Desktop-app OAuth client, publish the consent screen to
 *      Production (Testing expires refresh tokens after 7 days)
 *   2. Paste Client ID + Secret
 *   3. Authorize — opens the system browser; a loopback redirect completes it
 *
 * The client secret + tokens are encrypted device-local in the main process
 * (window.cerebro.gmail.startOAuth); nothing sensitive reaches the renderer.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  X,
  XCircle,
} from 'lucide-react';

interface Props {
  onClose: () => void;
  onPersisted?: () => void;
}

type AuthState =
  | { kind: 'idle' }
  | { kind: 'authorizing' }
  | { kind: 'ok'; email: string }
  | { kind: 'err'; error: string };

const STEP_COUNT = 3;
const CONSOLE_URL = 'https://console.cloud.google.com/apis/credentials';

export default function GmailConnectModal({ onClose, onPersisted }: Props) {
  const { t } = useTranslation();
  const [step, setStep] = useState(1);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [auth, setAuth] = useState<AuthState>({ kind: 'idle' });

  const authorize = async () => {
    setAuth({ kind: 'authorizing' });
    try {
      const res = await window.cerebro.gmail.startOAuth({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      });
      if (res.ok && res.account) {
        setAuth({ kind: 'ok', email: res.account.email });
        onPersisted?.();
      } else {
        setAuth({ kind: 'err', error: res.error ?? 'Unknown error' });
      }
    } catch (err) {
      setAuth({ kind: 'err', error: err instanceof Error ? err.message : String(err) });
    }
  };

  const canNext = step === 2 ? Boolean(clientId.trim() && clientSecret.trim()) : true;

  const guideSteps = [
    t('integrations.gmail.steps.createProject'),
    t('integrations.gmail.steps.enableApi'),
    t('integrations.gmail.steps.createOAuthClient'),
    t('integrations.gmail.steps.publishConsent'),
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[480px] max-w-[92vw] rounded-xl border border-border-subtle bg-bg-base shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
          <h2 className="flex-1 text-[15px] font-semibold text-text-primary">
            {t('gmail.connectModal.title')}
          </h2>
          <span className="text-[11px] text-text-tertiary">
            {step}/{STEP_COUNT}
          </span>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-secondary">
            <X size={16} />
          </button>
        </div>

        <div className="px-4 py-4 min-h-[230px]">
          {step === 1 && (
            <div>
              <p className="text-[13px] text-text-secondary mb-3">
                {t('gmail.connectModal.guideIntro')}
              </p>
              <ol className="space-y-2 mb-3">
                {guideSteps.map((s, i) => (
                  <li key={i} className="flex gap-2 text-[12px] text-text-secondary">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-bg-surface border border-border-subtle text-text-tertiary text-[11px] flex items-center justify-center">
                      {i + 1}
                    </span>
                    <span className="pt-0.5">{s}</span>
                  </li>
                ))}
              </ol>
              <a
                href={CONSOLE_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-[12px] text-accent hover:underline"
              >
                {t('gmail.connectModal.openConsole')} <ExternalLink size={12} />
              </a>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <p className="text-[12px] text-text-tertiary">
                {t('gmail.connectModal.credentialsHelp')}
              </p>
              <div>
                <label className="block text-[11px] uppercase tracking-wide text-text-tertiary mb-1">
                  {t('integrations.gmail.fields.clientId')}
                </label>
                <input
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder={t('integrations.gmail.hints.clientId')}
                  className="w-full bg-bg-surface border border-border-subtle rounded-md px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
                />
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-wide text-text-tertiary mb-1">
                  {t('integrations.gmail.fields.clientSecret')}
                </label>
                <div className="relative">
                  <input
                    type={showSecret ? 'text' : 'password'}
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    className="w-full bg-bg-surface border border-border-subtle rounded-md px-2.5 py-1.5 pr-8 text-[13px] text-text-primary outline-none focus:border-accent"
                  />
                  <button
                    onClick={() => setShowSecret((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary"
                  >
                    {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
              <p className="text-[11px] text-text-tertiary">
                {t('gmail.connectModal.redirectHint')}
              </p>
            </div>
          )}

          {step === 3 && (
            <div className="flex flex-col items-center justify-center text-center py-4">
              {auth.kind === 'idle' && (
                <>
                  <p className="text-[13px] text-text-secondary mb-4">
                    {t('gmail.connectModal.authorizeHelp')}
                  </p>
                  <button
                    onClick={authorize}
                    className="px-4 py-2 rounded-md text-[13px] bg-accent text-black font-medium hover:brightness-110"
                  >
                    {t('gmail.connectModal.authorize')}
                  </button>
                </>
              )}
              {auth.kind === 'authorizing' && (
                <div className="flex flex-col items-center gap-2 text-text-secondary">
                  <Loader2 size={22} className="animate-spin text-accent" />
                  <p className="text-[13px]">{t('gmail.connectModal.authorizing')}</p>
                </div>
              )}
              {auth.kind === 'ok' && (
                <div className="flex flex-col items-center gap-2">
                  <CheckCircle2 size={28} className="text-emerald-400" />
                  <p className="text-[13px] text-text-secondary">
                    {t('gmail.connectModal.success', { email: auth.email })}
                  </p>
                  <button
                    onClick={onClose}
                    className="mt-2 px-3 py-1 rounded-md text-[12px] bg-accent text-black font-medium"
                  >
                    {t('gmail.connectModal.done')}
                  </button>
                </div>
              )}
              {auth.kind === 'err' && (
                <div className="flex flex-col items-center gap-2">
                  <XCircle size={28} className="text-red-400" />
                  <p className="text-[12px] text-red-400 max-w-xs">
                    {t('gmail.connectModal.error', { error: auth.error })}
                  </p>
                  <button
                    onClick={() => setAuth({ kind: 'idle' })}
                    className="mt-2 px-3 py-1 rounded-md text-[12px] bg-bg-surface text-text-secondary hover:bg-bg-hover"
                  >
                    {t('gmail.connectModal.back')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer nav (hidden on the success screen) */}
        {!(step === 3 && auth.kind === 'ok') && (
          <div className="flex items-center justify-between border-t border-border-subtle px-4 py-2.5">
            <button
              onClick={() => (step === 1 ? onClose() : setStep((s) => s - 1))}
              disabled={auth.kind === 'authorizing'}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] text-text-tertiary hover:text-text-secondary disabled:opacity-50"
            >
              <ArrowLeft size={13} />{' '}
              {step === 1 ? t('gmail.connectModal.cancel') : t('gmail.connectModal.back')}
            </button>
            {step < 3 && (
              <button
                onClick={() => setStep((s) => s + 1)}
                disabled={!canNext}
                className="flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] bg-accent text-black font-medium hover:brightness-110 disabled:opacity-40"
              >
                {t('gmail.connectModal.next')} <ArrowRight size={13} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
