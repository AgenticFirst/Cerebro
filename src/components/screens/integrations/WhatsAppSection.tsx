import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Trans, useTranslation } from 'react-i18next';
import { CheckCircle2, Loader2, ShieldAlert, XCircle } from 'lucide-react';
import { WhatsAppIcon } from '../../icons/BrandIcons';
import type { WhatsAppStatusResponse } from '../../../types/ipc';
import { parseAllowlistRaw } from '../../../whatsapp/helpers';
import { loadSetting, saveSetting } from '../../../lib/settings';
import { WHATSAPP_SETTING_KEYS } from '../../../whatsapp/types';
import WhatsAppOperatorClients from './WhatsAppOperatorClients';

interface WhatsAppSectionProps {
  showHeader?: boolean;
  backendPort?: number;
}

export default function WhatsAppSection({ showHeader = false, backendPort = 8000 }: WhatsAppSectionProps = {}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<WhatsAppStatusResponse | null>(null);
  const [allowlistRaw, setAllowlistRaw] = useState('');
  const [allowAny, setAllowAny] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [pairingBusy, setPairingBusy] = useState(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Business profile
  const [businessName, setBusinessName] = useState('');
  const [businessDescription, setBusinessDescription] = useState('');
  const [businessHours, setBusinessHours] = useState('');
  const [knowledgeBase, setKnowledgeBase] = useState('');
  const [bookingUrl, setBookingUrl] = useState('');
  const [poweredByFooter, setPoweredByFooter] = useState(true);
  const [bizSavedFlash, setBizSavedFlash] = useState(false);
  const bizFlashRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshStatus = useCallback(async () => {
    const s = await window.cerebro.whatsapp.status();
    setStatus(s);
  }, []);

  useEffect(() => {
    void refreshStatus();
    const off = window.cerebro.whatsapp.onStatusChanged((s) => setStatus(s));
    void loadSetting<string[]>(WHATSAPP_SETTING_KEYS.allowlist).then((saved) => {
      if (!saved || saved.length === 0) return;
      if (saved.includes('*')) { setAllowAny(true); } else { setAllowlistRaw(saved.join(', ')); }
    });
    void loadSetting<string>(WHATSAPP_SETTING_KEYS.businessName).then((v) => v && setBusinessName(v));
    void loadSetting<string>(WHATSAPP_SETTING_KEYS.businessDescription).then((v) => v && setBusinessDescription(v));
    void loadSetting<string>(WHATSAPP_SETTING_KEYS.businessHours).then((v) => v && setBusinessHours(v));
    void loadSetting<string>(WHATSAPP_SETTING_KEYS.knowledgeBase).then((v) => v && setKnowledgeBase(v));
    void loadSetting<string>(WHATSAPP_SETTING_KEYS.bookingUrl).then((v) => v && setBookingUrl(v));
    void loadSetting<boolean>(WHATSAPP_SETTING_KEYS.poweredByFooter).then((v) => { if (typeof v === 'boolean') setPoweredByFooter(v); });
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
    const list = allowAny ? ['*'] : parseAllowlistRaw(allowlistRaw);
    await window.cerebro.whatsapp.setAllowlist(list);
    setSavedFlash(true);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setSavedFlash(false), 1_500);
  }, [allowlistRaw, allowAny]);

  const applyClientProfile = useCallback(async (client: {
    business_name: string; business_description: string;
    business_hours: string; powered_by_footer: boolean;
    knowledge_base?: string; booking_url?: string;
  }) => {
    setBusinessName(client.business_name);
    setBusinessDescription(client.business_description);
    setBusinessHours(client.business_hours);
    setKnowledgeBase(client.knowledge_base ?? '');
    setBookingUrl(client.booking_url ?? '');
    setPoweredByFooter(client.powered_by_footer);
    await Promise.all([
      saveSetting(WHATSAPP_SETTING_KEYS.businessName, client.business_name),
      saveSetting(WHATSAPP_SETTING_KEYS.businessDescription, client.business_description),
      saveSetting(WHATSAPP_SETTING_KEYS.businessHours, client.business_hours),
      saveSetting(WHATSAPP_SETTING_KEYS.knowledgeBase, client.knowledge_base ?? ''),
      saveSetting(WHATSAPP_SETTING_KEYS.bookingUrl, client.booking_url ?? ''),
      saveSetting(WHATSAPP_SETTING_KEYS.poweredByFooter, client.powered_by_footer),
    ]);
    setBizSavedFlash(true);
    if (bizFlashRef.current) clearTimeout(bizFlashRef.current);
    bizFlashRef.current = setTimeout(() => setBizSavedFlash(false), 1_500);
  }, []);

  const saveBusinessProfile = useCallback(async () => {
    await Promise.all([
      saveSetting(WHATSAPP_SETTING_KEYS.businessName, businessName),
      saveSetting(WHATSAPP_SETTING_KEYS.businessDescription, businessDescription),
      saveSetting(WHATSAPP_SETTING_KEYS.businessHours, businessHours),
      saveSetting(WHATSAPP_SETTING_KEYS.knowledgeBase, knowledgeBase),
      saveSetting(WHATSAPP_SETTING_KEYS.bookingUrl, bookingUrl),
      saveSetting(WHATSAPP_SETTING_KEYS.poweredByFooter, poweredByFooter),
    ]);
    setBizSavedFlash(true);
    if (bizFlashRef.current) clearTimeout(bizFlashRef.current);
    bizFlashRef.current = setTimeout(() => setBizSavedFlash(false), 1_500);
  }, [businessName, businessDescription, businessHours, poweredByFooter]);

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

      {/* ── Business Profile ─────────────────────────────────────── */}
      <div className="mt-6 rounded-lg border border-border-subtle bg-bg-surface p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-text-primary">🏢 Business Profile</h3>
          <span className="text-[10px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">AI persona</span>
        </div>
        <p className="text-[11px] text-text-tertiary">Tell Cerebro about your business so the AI replies as your brand.</p>

        <div>
          <label className="text-xs text-text-secondary">Business name</label>
          <input
            type="text"
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            placeholder="e.g. Miami Beauty Clinic"
            className="mt-1 w-full bg-bg-elevated border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
          />
        </div>

        <div>
          <label className="text-xs text-text-secondary">What you offer (1-2 sentences)</label>
          <textarea
            value={businessDescription}
            onChange={(e) => setBusinessDescription(e.target.value)}
            placeholder="e.g. We offer botox, fillers, and laser treatments. We serve clients in Miami and Broward County."
            rows={2}
            className="mt-1 w-full bg-bg-elevated border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 resize-none"
          />
        </div>

        <div>
          <label className="text-xs text-text-secondary">Business hours</label>
          <input
            type="text"
            value={businessHours}
            onChange={(e) => setBusinessHours(e.target.value)}
            placeholder="e.g. Mon–Fri 9am–6pm, Sat 10am–3pm"
            className="mt-1 w-full bg-bg-elevated border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
          />
        </div>

        <div>
          <label className="text-xs text-text-secondary flex items-center gap-1.5">
            📅 Booking / Calendar URL
          </label>
          <input
            type="url"
            value={bookingUrl}
            onChange={(e) => setBookingUrl(e.target.value)}
            placeholder="https://calendly.com/yourbusiness or Google Calendar link"
            className="mt-1 w-full bg-bg-elevated border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
          />
          <p className="mt-1 text-[10px] text-text-tertiary">When a customer asks to book, the bot sends this link automatically.</p>
        </div>

        <div>
          <label className="text-xs text-text-secondary flex items-center gap-1.5">
            📚 Knowledge Base
          </label>
          <textarea
            value={knowledgeBase}
            onChange={(e) => setKnowledgeBase(e.target.value)}
            placeholder={`Paste your FAQ, pricing, services, policies here.\n\nExample:\nServices: Botox $250, Fillers $400, Laser $300\nPayment: Cash, card, Venmo accepted\nLocation: 123 Main St, Miami FL\nFAQ: Do you accept walk-ins? Yes, Mon-Fri only.`}
            rows={8}
            className="mt-1 w-full bg-bg-elevated border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 resize-y font-mono text-xs"
          />
          <p className="mt-1 text-[10px] text-text-tertiary">The AI reads this to answer customer questions accurately. Add prices, FAQs, locations, policies — anything customers ask about.</p>
        </div>

        <label className="flex items-center gap-2 cursor-pointer select-none pt-1">
          <input
            type="checkbox"
            checked={poweredByFooter}
            onChange={(e) => setPoweredByFooter(e.target.checked)}
            className="rounded border-border-subtle accent-accent"
          />
          <span className="text-xs text-text-secondary">Add <em>"✨ Powered by Cerebro AI"</em> footer to replies</span>
        </label>

        <div className="flex items-center justify-end gap-3">
          {bizSavedFlash && (
            <span className="text-xs text-emerald-400 flex items-center gap-1.5">
              <CheckCircle2 size={12} /> Saved
            </span>
          )}
          <button
            type="button"
            onClick={saveBusinessProfile}
            className="px-3 py-1.5 text-xs rounded-md font-medium bg-accent/15 text-accent hover:bg-accent/25"
          >
            Save profile
          </button>
        </div>
      </div>

      {/* Allowlist */}
      <div className="mt-6">
        <label className="text-xs font-medium text-text-secondary">{t('whatsappSection.allowlistLabel')}</label>
        <label className="mt-2 flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={allowAny}
            onChange={(e) => setAllowAny(e.target.checked)}
            className="rounded border-border-subtle accent-accent"
          />
          <span className="text-xs text-text-secondary">{t('whatsappSection.allowAny', 'Allow messages from any contact')}</span>
        </label>
        <input
          type="text"
          value={allowlistRaw}
          onChange={(e) => { setAllowlistRaw(e.target.value); setAllowAny(false); }}
          placeholder={t('whatsappSection.allowlistPlaceholder')}
          disabled={allowAny}
          className="mt-2 w-full bg-bg-surface border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 disabled:opacity-40"
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
      {/* Operator: multi-client management */}
      <WhatsAppOperatorClients
        backendPort={backendPort}
        onApplyProfile={applyClientProfile}
      />
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
