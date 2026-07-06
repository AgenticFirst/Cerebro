/**
 * Bring-your-own OAuth connect flow for the Google Drive MCP server:
 *   1. Walkthrough — Workspace Developer Preview enrollment + enable the
 *      Drive API and the Drive MCP API + create a Desktop-app OAuth client
 *      (or reuse the one already created for Gmail)
 *   2. Credentials — reuse the Gmail client with one click, or paste a
 *      Client ID + Secret
 *   3. Authorize — opens the system browser; a loopback redirect completes it
 *
 * Same shape as GmailConnectModal; secrets never reach the renderer.
 */

import { useEffect, useState } from 'react';
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
import clsx from 'clsx';

interface Props {
  onClose: () => void;
  onPersisted?: () => void;
}

type AuthState =
  | { kind: 'idle' }
  | { kind: 'authorizing' }
  | { kind: 'ok'; account: string }
  | { kind: 'err'; error: string };

const STEP_COUNT = 3;
const PREVIEW_URL = 'https://developers.google.com/workspace/preview';
const CONSOLE_URL = 'https://console.cloud.google.com/apis/credentials';

export default function GoogleDriveConnectModal({ onClose, onPersisted }: Props) {
  const { t } = useTranslation();
  const [step, setStep] = useState(1);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [hasGmailClient, setHasGmailClient] = useState(false);
  const [reuseGmail, setReuseGmail] = useState(false);
  const [auth, setAuth] = useState<AuthState>({ kind: 'idle' });

  useEffect(() => {
    void window.cerebro.mcp.gdriveHasGmailClient().then((has) => {
      setHasGmailClient(has);
      setReuseGmail(has);
    });
  }, []);

  const authorize = async () => {
    setAuth({ kind: 'authorizing' });
    try {
      const res = await window.cerebro.mcp.startGoogleDriveOAuth(
        reuseGmail
          ? { reuseGmail: true }
          : { clientId: clientId.trim(), clientSecret: clientSecret.trim() },
      );
      if (res.ok && res.server) {
        setAuth({ kind: 'ok', account: res.server.accountLabel ?? '' });
        onPersisted?.();
      } else {
        setAuth({ kind: 'err', error: res.error ?? 'Unknown error' });
        if (res.server) onPersisted?.(); // OAuth ok, discovery failed — server exists
      }
    } catch (err) {
      setAuth({ kind: 'err', error: err instanceof Error ? err.message : String(err) });
    }
  };

  const canNext = step === 2 ? reuseGmail || Boolean(clientId.trim() && clientSecret.trim()) : true;

  const guideSteps = [
    t('mcp.drive.steps.enrollPreview'),
    t('mcp.drive.steps.enableApis'),
    t('mcp.drive.steps.createOAuthClient'),
    t('mcp.drive.steps.publishConsent'),
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
            {t('mcp.drive.title')}
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
              <p className="text-[13px] text-text-secondary mb-3">{t('mcp.drive.guideIntro')}</p>
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
              <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-300 mb-3">
                {t('mcp.drive.previewWarning')}
              </div>
              <div className="flex items-center gap-4">
                <a
                  href={PREVIEW_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-[12px] text-accent hover:underline"
                >
                  {t('mcp.drive.openPreview')} <ExternalLink size={12} />
                </a>
                <a
                  href={CONSOLE_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-[12px] text-accent hover:underline"
                >
                  {t('mcp.drive.openConsole')} <ExternalLink size={12} />
                </a>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              {hasGmailClient && (
                <button
                  onClick={() => setReuseGmail((r) => !r)}
                  className={clsx(
                    'w-full text-left rounded-lg border px-3 py-2.5 transition-colors',
                    reuseGmail
                      ? 'border-accent/50 bg-accent/10'
                      : 'border-border-subtle bg-bg-surface/40 hover:bg-bg-hover',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <CheckCircle2
                      size={15}
                      className={reuseGmail ? 'text-accent' : 'text-text-tertiary'}
                    />
                    <span className="text-[13px] font-medium text-text-primary">
                      {t('mcp.drive.reuseGmail')}
                    </span>
                  </div>
                  <p className="text-[11px] text-text-tertiary mt-1 ml-6">
                    {t('mcp.drive.reuseGmailHelp')}
                  </p>
                </button>
              )}

              {!reuseGmail && (
                <>
                  <p className="text-[12px] text-text-tertiary">{t('mcp.drive.credentialsHelp')}</p>
                  <div>
                    <label className="block text-[11px] uppercase tracking-wide text-text-tertiary mb-1">
                      {t('mcp.drive.fields.clientId')}
                    </label>
                    <input
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                      placeholder="xxxxx.apps.googleusercontent.com"
                      className="w-full bg-bg-surface border border-border-subtle rounded-md px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] uppercase tracking-wide text-text-tertiary mb-1">
                      {t('mcp.drive.fields.clientSecret')}
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
                </>
              )}
              <p className="text-[11px] text-text-tertiary">{t('mcp.drive.scopeHint')}</p>
            </div>
          )}

          {step === 3 && (
            <div className="flex flex-col items-center justify-center text-center py-4">
              {auth.kind === 'idle' && (
                <>
                  <p className="text-[13px] text-text-secondary mb-4">
                    {t('mcp.drive.authorizeHelp')}
                  </p>
                  <button
                    onClick={authorize}
                    className="px-4 py-2 rounded-md text-[13px] bg-accent text-black font-medium hover:brightness-110"
                  >
                    {t('mcp.drive.authorize')}
                  </button>
                </>
              )}
              {auth.kind === 'authorizing' && (
                <div className="flex flex-col items-center gap-2 text-text-secondary">
                  <Loader2 size={22} className="animate-spin text-accent" />
                  <p className="text-[13px]">{t('mcp.drive.authorizing')}</p>
                </div>
              )}
              {auth.kind === 'ok' && (
                <div className="flex flex-col items-center gap-2">
                  <CheckCircle2 size={28} className="text-emerald-400" />
                  <p className="text-[13px] text-text-secondary">
                    {t('mcp.drive.success', { account: auth.account })}
                  </p>
                  <button
                    onClick={onClose}
                    className="mt-2 px-3 py-1 rounded-md text-[12px] bg-accent text-black font-medium"
                  >
                    {t('mcp.drive.done')}
                  </button>
                </div>
              )}
              {auth.kind === 'err' && (
                <div className="flex flex-col items-center gap-2">
                  <XCircle size={28} className="text-red-400" />
                  <p className="text-[12px] text-red-400 max-w-xs">
                    {t('mcp.drive.error', { error: auth.error })}
                  </p>
                  <button
                    onClick={() => setAuth({ kind: 'idle' })}
                    className="mt-2 px-3 py-1 rounded-md text-[12px] bg-bg-surface text-text-secondary hover:bg-bg-hover"
                  >
                    {t('mcp.drive.back')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {!(step === 3 && auth.kind === 'ok') && (
          <div className="flex items-center justify-between border-t border-border-subtle px-4 py-2.5">
            <button
              onClick={() => (step === 1 ? onClose() : setStep((s) => s - 1))}
              disabled={auth.kind === 'authorizing'}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] text-text-tertiary hover:text-text-secondary disabled:opacity-50"
            >
              <ArrowLeft size={13} /> {step === 1 ? t('mcp.drive.cancel') : t('mcp.drive.back')}
            </button>
            {step < 3 && (
              <button
                onClick={() => setStep((s) => s + 1)}
                disabled={!canNext}
                className="flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] bg-accent text-black font-medium hover:brightness-110 disabled:opacity-40"
              >
                {t('mcp.drive.next')} <ArrowRight size={13} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
