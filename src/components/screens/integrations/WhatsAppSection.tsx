import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { CheckCircle2, Loader2, ShieldAlert, XCircle } from 'lucide-react';
import { WhatsAppIcon } from '../../icons/BrandIcons';
import type { WhatsAppStatusResponse } from '../../../types/ipc';
import { parseAllowlistRaw } from '../../../whatsapp/helpers';

interface WhatsAppSectionProps {
  showHeader?: boolean;
}

export default function WhatsAppSection({ showHeader = false }: WhatsAppSectionProps = {}) {
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
            <h2 className="text-lg font-medium text-text-primary">WhatsApp Business</h2>
          </div>
          <p className="text-sm text-text-secondary mt-3 leading-relaxed">
            Pair a WhatsApp Business number to Cerebro and let routines respond to inbound customer messages.
          </p>
        </>
      )}

      {/* Dedicated-number safety callout */}
      <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-amber-500/30 bg-amber-500/10 text-xs text-amber-300">
        <ShieldAlert size={14} className="mt-0.5 flex-shrink-0" />
        <span className="leading-relaxed">
          Use a dedicated WhatsApp Business number for this integration. WhatsApp may rate-limit or ban
          accounts it detects as automated — the risk is lower on a Business account with a dedicated number
          you aren't also using for personal chats.
        </span>
      </div>

      {/* Storage backend banner */}
      {status && (
        <div className="mt-3 flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-300">
          <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0" />
          <span className="leading-relaxed">
            Session {usingKeychain ? 'encrypted via the OS keychain' : 'stored under Cerebro\'s user-data directory (OS-level file permissions)'}.
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
            Pair a WhatsApp device
          </button>
          <p className="mt-2 text-[11px] text-text-tertiary leading-relaxed">
            Opens a QR code. Scan it from WhatsApp → Settings → Linked devices → Link a device.
          </p>
        </div>
      )}

      {state === 'pairing' && (
        <div className="mt-4 rounded-lg border border-border-subtle bg-bg-surface p-4">
          <div className="text-sm text-text-primary font-medium mb-2">Scan to pair</div>
          {status?.qr ? (
            <>
              <img
                src={status.qr}
                alt="WhatsApp pairing QR code"
                className="w-[240px] h-[240px] rounded-md bg-white p-2 mx-auto"
              />
              <p className="mt-3 text-[11px] text-text-tertiary leading-relaxed text-center">
                Open WhatsApp on your phone → Settings → Linked devices → Link a device → scan this code.
              </p>
            </>
          ) : (
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <Loader2 size={14} className="animate-spin" /> Waiting for a QR code…
            </div>
          )}
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={cancelPairing}
              className="px-3 py-1.5 text-xs rounded-md text-text-tertiary hover:text-red-400"
            >
              Cancel
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
            Disconnect + wipe session
          </button>
        </div>
      )}

      {/* Allowlist */}
      <div className="mt-6">
        <label className="text-xs font-medium text-text-secondary">Allowed customer numbers</label>
        <input
          type="text"
          value={allowlistRaw}
          onChange={(e) => setAllowlistRaw(e.target.value)}
          placeholder="+14155552671, +491701234567    or    *"
          className="mt-1.5 w-full bg-bg-surface border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
          spellCheck={false}
        />
        <p className="mt-1.5 text-[11px] text-text-tertiary leading-relaxed">
          Only messages from these numbers will trigger routines. Use <code>*</code> to allow any caller
          (recommended only on a dedicated business number with strong filtering in your routine triggers).
        </p>
        <div className="mt-2 flex items-center justify-end gap-3">
          {savedFlash && (
            <span className="text-xs text-emerald-400 flex items-center gap-1.5">
              <CheckCircle2 size={12} /> Saved
            </span>
          )}
          <button
            type="button"
            onClick={saveAllowlist}
            className="px-3 py-1.5 text-xs rounded-md font-medium bg-accent/15 text-accent hover:bg-accent/25"
          >
            Save allowlist
          </button>
        </div>
      </div>
    </div>
  );
}

const STATE_PILL_CONFIG: Record<WhatsAppStatusResponse['state'], { label: string; className: string }> = {
  off: { label: 'Not paired', className: 'text-text-tertiary border-border-subtle bg-bg-elevated' },
  pairing: { label: 'Pairing', className: 'text-amber-400 border-amber-500/30 bg-amber-500/10' },
  connecting: { label: 'Connecting', className: 'text-amber-400 border-amber-500/30 bg-amber-500/10' },
  connected: { label: 'Connected', className: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
  error: { label: 'Error', className: 'text-red-400 border-red-500/30 bg-red-500/10' },
};

function StatePill({ state }: { state: WhatsAppStatusResponse['state'] }) {
  const cfg = STATE_PILL_CONFIG[state];
  const spinning = state === 'pairing' || state === 'connecting';
  return (
    <span className={clsx('text-[10px] font-medium px-2 py-1 rounded-full border flex items-center gap-1.5', cfg.className)}>
      {spinning
        ? <Loader2 size={11} className="animate-spin" />
        : state === 'connected' ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
      {cfg.label}
    </span>
  );
}
