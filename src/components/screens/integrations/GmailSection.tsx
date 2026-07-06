/**
 * Gmail management UI (Integrations → Connected apps → Gmail).
 * Shows the connected account with live status, sends-today counter, and
 * reconnect / disconnect. "Connect Gmail" opens the BYO-client OAuth flow.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, RefreshCw, Trash2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import clsx from 'clsx';
import { GmailIcon } from '../../icons/BrandIcons';
import type { GmailAccountInfo, GmailStatus } from '../../../gmail/types';
import GmailConnectModal from './GmailConnectModal';
import AlertModal from '../../ui/AlertModal';

function statusPill(status: GmailAccountInfo['status'], t: (k: string) => string) {
  const map: Record<GmailAccountInfo['status'], { cls: string; label: string }> = {
    connected: {
      cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
      label: t('gmail.status.connected'),
    },
    token_expired: {
      cls: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
      label: t('gmail.status.tokenExpired'),
    },
    error: {
      cls: 'border-red-500/30 bg-red-500/10 text-red-400',
      label: t('gmail.status.error'),
    },
  };
  const { cls, label } = map[status];
  return (
    <span
      className={clsx(
        'text-[10px] font-medium px-2 py-0.5 rounded-full border flex items-center gap-1',
        cls,
      )}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" /> {label}
    </span>
  );
}

export default function GmailSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [showConnect, setShowConnect] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDisconnect, setPendingDisconnect] = useState<GmailAccountInfo | null>(null);

  const refresh = useCallback(async () => {
    setStatus(await window.cerebro.gmail.status());
  }, []);

  useEffect(() => {
    void refresh();
    const off = window.cerebro.gmail.onChanged(() => void refresh());
    const id = setInterval(refresh, 15_000);
    return () => {
      off();
      clearInterval(id);
    };
  }, [refresh]);

  const reconnect = async (id: string) => {
    setBusyId(id);
    await window.cerebro.gmail.reconnect(id);
    setBusyId(null);
    void refresh();
  };

  const disconnect = async (acc: GmailAccountInfo) => {
    setPendingDisconnect(null);
    setBusyId(acc.id);
    await window.cerebro.gmail.disconnect(acc.id);
    setBusyId(null);
    void refresh();
  };

  const accounts = status?.accounts ?? [];

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-text-secondary">{t('gmail.section.description')}</p>

      {accounts.map((acc) => (
        <div key={acc.id} className="rounded-lg border border-border-subtle bg-bg-surface/40 p-3">
          <div className="flex items-center gap-2.5">
            <GmailIcon size={18} />
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium text-text-primary truncate">{acc.email}</div>
              <div className="text-[11px] text-text-tertiary">
                {t('gmail.section.sentToday').replace('{{count}}', String(status?.sentToday ?? 0))}
              </div>
            </div>
            {statusPill(acc.status, t)}
          </div>

          {acc.lastError && acc.status !== 'connected' && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-400">
              <AlertTriangle size={12} /> {acc.lastError}
            </div>
          )}

          <div className="mt-3 flex items-center gap-2">
            {acc.status !== 'connected' && (
              <button
                onClick={() => void reconnect(acc.id)}
                disabled={busyId === acc.id}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-50"
              >
                <RefreshCw size={11} /> {t('gmail.section.reconnect')}
              </button>
            )}
            <button
              onClick={() => setPendingDisconnect(acc)}
              disabled={busyId === acc.id}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] text-red-400 hover:bg-red-500/10 disabled:opacity-50"
            >
              <Trash2 size={11} /> {t('gmail.section.disconnect')}
            </button>
          </div>
        </div>
      ))}

      {accounts.length === 0 && (
        <>
          <button
            onClick={() => setShowConnect(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] bg-accent/15 text-accent hover:bg-accent/25"
          >
            <Plus size={13} /> {t('gmail.section.connect')}
          </button>
          <div className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
            <CheckCircle2 size={12} /> {t('gmail.section.noAccountHint')}
          </div>
        </>
      )}

      {showConnect && (
        <GmailConnectModal
          onClose={() => {
            setShowConnect(false);
            void refresh();
          }}
          onPersisted={() => void refresh()}
        />
      )}

      {pendingDisconnect && (
        <AlertModal
          iconTone="danger"
          icon={<Trash2 size={16} className="text-red-400" />}
          title={t('gmail.section.disconnect')}
          message={t('gmail.section.disconnectConfirm').replace(
            '{{email}}',
            pendingDisconnect.email,
          )}
          onClose={() => setPendingDisconnect(null)}
          actions={[
            { label: t('gmail.section.cancel'), onClick: () => setPendingDisconnect(null) },
            {
              label: t('gmail.section.disconnect'),
              primary: true,
              variant: 'danger',
              onClick: () => void disconnect(pendingDisconnect),
            },
          ]}
        />
      )}
    </div>
  );
}
