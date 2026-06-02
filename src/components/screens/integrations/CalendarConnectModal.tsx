/**
 * Bring-your-own OAuth connect flow for calendars:
 *   1. Choose provider (Google / Outlook)
 *   2. Paste Client ID + Secret (from the user's own Google Cloud / Azure app)
 *   3. Authorize — opens the system browser; a loopback redirect completes it
 *
 * The client secret + tokens are encrypted device-local in the main process
 * (window.cerebro.calendar.startOAuth); nothing sensitive reaches the renderer.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, CheckCircle2, Eye, EyeOff, Loader2, X, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { GoogleCalendarIcon, OutlookIcon } from '../../icons/BrandIcons';
import type { CalendarProviderId } from '../../../types/calendar';

interface Props {
  onClose: () => void;
  onPersisted?: () => void;
}

type AuthState =
  | { kind: 'idle' }
  | { kind: 'authorizing' }
  | { kind: 'ok'; email: string }
  | { kind: 'err'; error: string };

export default function CalendarConnectModal({ onClose, onPersisted }: Props) {
  const { t } = useTranslation();
  const [step, setStep] = useState(1);
  const [provider, setProvider] = useState<CalendarProviderId | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [auth, setAuth] = useState<AuthState>({ kind: 'idle' });

  const authorize = async () => {
    if (!provider) return;
    setAuth({ kind: 'authorizing' });
    try {
      const res = await window.cerebro.calendar.startOAuth({
        provider,
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

  const canNext = step === 1 ? Boolean(provider) : step === 2 ? clientId.trim() && clientSecret.trim() : true;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-[460px] max-w-[92vw] rounded-xl border border-border-subtle bg-bg-base shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
          <h2 className="flex-1 text-[15px] font-semibold text-text-primary">{t('calendar.connectModal.title')}</h2>
          <span className="text-[11px] text-text-tertiary">{step}/3</span>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-secondary"><X size={16} /></button>
        </div>

        <div className="px-4 py-4 min-h-[220px]">
          {step === 1 && (
            <div>
              <p className="text-[13px] text-text-secondary mb-3">{t('calendar.connectModal.chooseProvider')}</p>
              <div className="grid grid-cols-2 gap-3">
                <ProviderCard
                  active={provider === 'google'}
                  onClick={() => setProvider('google')}
                  icon={<GoogleCalendarIcon size={22} />}
                  label={t('calendar.connectModal.google')}
                />
                <ProviderCard
                  active={provider === 'outlook'}
                  onClick={() => setProvider('outlook')}
                  icon={<OutlookIcon size={22} />}
                  label={t('calendar.connectModal.outlook')}
                />
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <p className="text-[12px] text-text-tertiary">
                {provider === 'google' ? t('calendar.connectModal.googleHelp') : t('calendar.connectModal.outlookHelp')}
              </p>
              <div>
                <label className="block text-[11px] uppercase tracking-wide text-text-tertiary mb-1">
                  {t('calendar.connectModal.clientIdLabel')}
                </label>
                <input
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  className="w-full bg-bg-surface border border-border-subtle rounded-md px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
                />
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-wide text-text-tertiary mb-1">
                  {t('calendar.connectModal.clientSecretLabel')}
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
              <p className="text-[11px] text-text-tertiary">{t('calendar.connectModal.redirectHint')}</p>
            </div>
          )}

          {step === 3 && (
            <div className="flex flex-col items-center justify-center text-center py-4">
              {auth.kind === 'idle' && (
                <>
                  <p className="text-[13px] text-text-secondary mb-4">{t('calendar.connectModal.authorize')}</p>
                  <button
                    onClick={authorize}
                    className="px-4 py-2 rounded-md text-[13px] bg-accent text-black font-medium hover:brightness-110"
                  >
                    {t('calendar.connectModal.authorize')}
                  </button>
                </>
              )}
              {auth.kind === 'authorizing' && (
                <div className="flex flex-col items-center gap-2 text-text-secondary">
                  <Loader2 size={22} className="animate-spin text-accent" />
                  <p className="text-[13px]">{t('calendar.connectModal.authorizing')}</p>
                </div>
              )}
              {auth.kind === 'ok' && (
                <div className="flex flex-col items-center gap-2">
                  <CheckCircle2 size={28} className="text-emerald-400" />
                  <p className="text-[13px] text-text-secondary">{t('calendar.connectModal.success', { email: auth.email })}</p>
                  <button onClick={onClose} className="mt-2 px-3 py-1 rounded-md text-[12px] bg-accent text-black font-medium">
                    {t('calendar.event.save')}
                  </button>
                </div>
              )}
              {auth.kind === 'err' && (
                <div className="flex flex-col items-center gap-2">
                  <XCircle size={28} className="text-red-400" />
                  <p className="text-[12px] text-red-400 max-w-xs">{t('calendar.connectModal.error', { error: auth.error })}</p>
                  <button onClick={() => setAuth({ kind: 'idle' })} className="mt-2 px-3 py-1 rounded-md text-[12px] bg-bg-surface text-text-secondary hover:bg-bg-hover">
                    {t('calendar.connectModal.back')}
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
              <ArrowLeft size={13} /> {step === 1 ? t('calendar.connectModal.cancel') : t('calendar.connectModal.back')}
            </button>
            {step < 3 && (
              <button
                onClick={() => setStep((s) => s + 1)}
                disabled={!canNext}
                className="flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] bg-accent text-black font-medium hover:brightness-110 disabled:opacity-40"
              >
                {t('calendar.connectModal.next')} <ArrowRight size={13} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ProviderCard({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex flex-col items-center gap-2 px-4 py-5 rounded-lg border transition-colors',
        active ? 'border-accent bg-accent/10' : 'border-border-subtle hover:bg-bg-hover',
      )}
    >
      {icon}
      <span className="text-[12px] text-text-secondary">{label}</span>
    </button>
  );
}
