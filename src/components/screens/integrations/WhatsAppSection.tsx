import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Trans, useTranslation } from 'react-i18next';
import { CheckCircle2, Loader2, ShieldAlert, XCircle } from 'lucide-react';
import { WhatsAppIcon } from '../../icons/BrandIcons';
import type { WhatsAppStatusResponse } from '../../../types/ipc';
import { parseAllowlistRaw } from '../../../whatsapp/helpers';

interface WhatsAppSectionProps {
  showHeader?: boolean;
}

export default function WhatsAppSection({ showHeader = false }: WhatsAppSectionProps = {}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<WhatsAppStatusResponse | null>(null);
  const [allowlistRaw, setAllowlistRaw] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);
  const [pairingBusy, setPairingBusy] = useState(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshStatus = useCallback(async () => {
    const s = await window.cerebro.whatsapp.status();
    setStatus(s);
  }, []);

  useEffect(() => {
    void refreshStatus();
    const off = window.cerebro.whatsapp.onStatusChanged((s) => setStatus(s));
    return off;
  }, [refreshStatus]);

  const startPairing = useCallback(async () => {
    setPairingBusy(true);
    try {
      await window.cerebro.whatsapp.startPairing();
    } finally {
      setPairingBusy(false);
    }
  }, []);

  const cancelPairing = useCallback(async () => {
    await window.cerebro.whatsapp.cancelPairing();
    await refreshStatus();
  }, [refreshStatus]);

  const disconnect = useCallback(async () => {
    await window.cerebro.whatsapp.clearSession();
    await refreshStatus();
  }, [refreshStatus]);

  const saveAllowlist = useCallback(async () => {
    const list = parseAllowlistRaw(allowlistRaw);
    await window.cerebro.whatsapp.setAllowlist(list);
    setSavedFlash(true);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setSavedFlash(false), 1_500);
  }, [allowlistRaw]);

  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
  }, []);

  const usingKeychain = status?.credsBackend === 'os-keychain';
  const state = status?.state ?? 'off';

  return (
    <div>
      {showHeader && (
        <>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-emerald-500/15 text-emerald-400">
              <WhatsAppIcon size={18} />
            </div>
            <h2 className="text-lg font-medium text-text-primary">{t('whatsappSection.title')}</h2>
          </div>
          <p className="text-sm text-text-secondary mt-3 leading-relaxed">
            {t('whatsappSection.description')}
          </p>
        </>
      )}

      {/* Dedicated-number safety callout */}
      <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-amber-500/30 bg-amber-500/10 text-xs text-amber-300">
        <ShieldAlert size={14} className="mt-0.5 flex-shrink-0" />
        <span className="leading-relaxed">{t('whatsappSection.safetyCallout')}</span>
      </div>

      {/* Storage backend banner */}
      {status && (
        <div className="mt-3 flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-300">
          <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0" />
          <span className="leading-relaxed">
            {usingKeychain
              ? t('whatsappSection.sessionKeychain')
              : t('whatsappSection.sessionPlaintext')}
          </span>
        </div>
      )}

      {/* Status row */}
      <div className="mt-5 flex items-center gap-2 text-xs">
        <StatePill state={state} />
        {status?.phoneNumber && (
          <span className="text-text-secondary">
            {status.phoneNumber}{status.pushName ? ` · ${status.pushName}` : ''}
          </span>
        )}
        {status?.lastError && (
          <span className="text-red-400 break-all">{status.lastError}</span>
        )}
      </div>

      {/* Pairing flow */}
      {(state === 'off' || state === 'error') && (
        <div className="mt-4">
          <button
            type="button"
            onClick={startPairing}
            disabled={pairingBusy}
            className="px-3 py-2 text-sm rounded-md font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-50 flex items-center gap-1.5"
          >
            {pairingBusy && <Loader2 size={12} className="animate-spin" />}
            {t('whatsappSection.pairDevice')}
          </button>
          <p className="mt-2 text-[11px] text-text-tertiary leading-relaxed">
            {t('whatsappSection.pairHint')}
          </p>
        </div>
      )}

      {state === 'pairing' && (
        <div className="mt-4 rounded-lg border border-border-subtle bg-bg-surface p-4">
          <div className="text-sm text-text-primary font-medium mb-2">{t('whatsappSection.scanToPair')}</div>
          {status?.qr ? (
            <>
              <img
                src={status.qr}
                alt={t('whatsappSection.qrAltText')}
                className="w-[240px] h-[240px] rounded-md bg-white p-2 mx-auto"
              />
              <p className="mt-3 text-[11px] text-text-tertiary leading-relaxed text-center">
                {t('whatsappSection.scanInstructions')}
              </p>
            </>
          ) : (
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <Loader2 size={14} className="animate-spin" /> {t('whatsappSection.waitingForQr')}
            </div>
          )}
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={cancelPairing}
              className="px-3 py-1.5 text-xs rounded-md text-text-tertiary hover:text-red-400"
            >
              {t('whatsappSection.cancel')}
            </button>
          </div>
        </div>
      )}

      {(state === 'connected' || state === 'connecting') && (
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={disconnect}
            className="px-3 py-1.5 text-xs rounded-md font-medium text-text-tertiary hover:text-red-400"
          >
            {t('whatsappSection.disconnect')}
          </button>
        </div>
      )}

      {/* Allowlist */}
      <div className="mt-6">
        <label className="text-xs font-medium text-text-secondary">{t('whatsappSection.allowlistLabel')}</label>
        <input
          type="text"
          value={allowlistRaw}
          onChange={(e) => setAllowlistRaw(e.target.value)}
          placeholder={t('whatsappSection.allowlistPlaceholder')}
          className="mt-1.5 w-full bg-bg-surface border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
          spellCheck={false}
        />
        <p className="mt-1.5 text-[11px] text-text-tertiary leading-relaxed">
          <Trans
            i18nKey="whatsappSection.allowlistHelp"
            components={{ code: <code /> }}
          />
        </p>
        <div className="mt-2 flex items-center justify-end gap-3">
          {savedFlash && (
            <span className="text-xs text-emerald-400 flex items-center gap-1.5">
              <CheckCircle2 size={12} /> {t('whatsappSection.saved')}
            </span>
          )}
          <button
            type="button"
            onClick={saveAllowlist}
            className="px-3 py-1.5 text-xs rounded-md font-medium bg-accent/15 text-accent hover:bg-accent/25"
          >
            {t('whatsappSection.saveAllowlist')}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatePill({ state }: { state: WhatsAppStatusResponse['state'] }) {
  const { t } = useTranslation();
  const className = (() => {
    switch (state) {
      case 'off': return 'text-text-tertiary border-border-subtle bg-bg-elevated';
      case 'pairing':
      case 'connecting':
        return 'text-amber-400 border-amber-500/30 bg-amber-500/10';
      case 'connected': return 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10';
      case 'error': return 'text-red-400 border-red-500/30 bg-red-500/10';
    }
  })();
  const label = (() => {
    switch (state) {
      case 'off': return t('whatsappSection.statePillOff');
      case 'pairing': return t('whatsappSection.statePillPairing');
      case 'connecting': return t('whatsappSection.statePillConnecting');
      case 'connected': return t('whatsappSection.statePillConnected');
      case 'error': return t('whatsappSection.statePillError');
    }
  })();
  const spinning = state === 'pairing' || state === 'connecting';
  return (
    <span className={clsx('text-[10px] font-medium px-2 py-1 rounded-full border flex items-center gap-1.5', className)}>
      {spinning
        ? <Loader2 size={11} className="animate-spin" />
        : state === 'connected' ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
      {label}
    </span>
  );
}
