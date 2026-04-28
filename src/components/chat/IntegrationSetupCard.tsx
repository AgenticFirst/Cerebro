import { useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Plug, X, CheckCircle2, ExternalLink } from 'lucide-react';
import clsx from 'clsx';
import type { IntegrationSetupProposal } from '../../types/chat';
import { useChat } from '../../context/ChatContext';
import { apiPatchMessageMetadata, toApiIntegrationProposal } from '../../context/chat-helpers';
import { getIntegration } from '../../integrations/registry';

const TelegramConnectModal = lazy(() => import('../screens/integrations/TelegramConnectModal'));
const HubSpotConnectModal = lazy(() => import('../screens/integrations/HubSpotConnectModal'));
const WhatsAppConnectModal = lazy(() => import('../screens/integrations/WhatsAppConnectModal'));
const GenericConnectModal = lazy(() => import('../screens/integrations/GenericConnectModal'));

interface IntegrationSetupCardProps {
  proposal: IntegrationSetupProposal;
  messageId: string;
  conversationId: string;
}

function StatusBadge({ status }: { status: IntegrationSetupProposal['status'] }) {
  const { t } = useTranslation();
  const styles: Record<IntegrationSetupProposal['status'], string> = {
    proposed: 'bg-cyan-500/15 text-cyan-400',
    connecting: 'bg-yellow-500/15 text-yellow-400',
    connected: 'bg-green-500/15 text-green-400',
    dismissed: 'bg-zinc-500/15 text-zinc-400',
  };
  const labels: Record<IntegrationSetupProposal['status'], string> = {
    proposed: t('status.proposed'),
    connecting: t('status.previewing'),
    connected: t('integrations.card.connectedSubtitle'),
    dismissed: t('status.dismissed'),
  };
  return (
    <span className={clsx('text-[10px] font-medium px-1.5 py-0.5 rounded-full', styles[status])}>
      {labels[status]}
    </span>
  );
}

export default function IntegrationSetupCard({
  proposal,
  messageId,
  conversationId,
}: IntegrationSetupCardProps) {
  const { t } = useTranslation();
  const { updateMessage } = useChat();

  const manifest = getIntegration(proposal.integrationId);
  const integrationName = manifest ? t(manifest.nameKey) : proposal.integrationId;
  const modalOpen = proposal.status === 'connecting';

  const persist = useCallback(
    (next: IntegrationSetupProposal) => {
      updateMessage(conversationId, messageId, { integrationProposal: next });
      apiPatchMessageMetadata(conversationId, messageId, {
        integration_proposal: toApiIntegrationProposal(next),
      }).catch(console.error);
    },
    [conversationId, messageId, updateMessage],
  );

  // While the per-provider modal is open, poll status so the card
  // auto-flips to 'connected' when setup finishes. The ref guard stops
  // the poll from re-firing persist() once we've already transitioned.
  const flippedToConnectedRef = useRef(false);
  useEffect(() => {
    if (!manifest || !modalOpen) {
      flippedToConnectedRef.current = false;
      return;
    }
    let cancelled = false;
    const poll = async () => {
      if (flippedToConnectedRef.current) return;
      try {
        const s = await manifest.ipc.status();
        if (!cancelled && s.connected) {
          flippedToConnectedRef.current = true;
          persist({ ...proposal, status: 'connected' });
        }
      } catch { /* status is best-effort */ }
    };
    void poll();
    const id = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [manifest, modalOpen, persist, proposal]);

  const openModal = () => {
    if (proposal.status !== 'connecting') {
      persist({ ...proposal, status: 'connecting' });
    }
  };

  const closeModal = async () => {
    if (!manifest) {
      persist({ ...proposal, status: 'proposed' });
      return;
    }
    try {
      const s = await manifest.ipc.status();
      persist({ ...proposal, status: s.connected ? 'connected' : 'proposed' });
    } catch {
      persist({ ...proposal, status: 'proposed' });
    }
  };

  const handleDismiss = () => persist({ ...proposal, status: 'dismissed' });

  const isCollapsed = proposal.status === 'dismissed' || proposal.status === 'connected';

  if (!manifest) {
    // Defensive: integration was removed from the registry after the proposal
    // was persisted. Show a soft note rather than crashing the chat.
    return (
      <div className="rounded-lg border border-border-subtle bg-bg-surface/30 px-3 py-2 text-[11px] text-text-tertiary">
        Unknown integration: {proposal.integrationId}
      </div>
    );
  }

  return (
    <>
      <div
        className={clsx(
          'animate-card-in rounded-lg border overflow-hidden',
          isCollapsed ? 'border-border-subtle bg-bg-surface/30 opacity-70' : 'border-accent/30 bg-bg-surface/50',
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 px-3 py-2">
          <Plug size={14} className={isCollapsed ? 'text-text-tertiary' : 'text-accent'} />
          <span
            className={clsx(
              'flex-1 text-xs font-medium truncate',
              isCollapsed ? 'text-text-tertiary' : 'text-text-secondary',
            )}
          >
            {t('integrations.card.cardTitle', { name: integrationName })}
          </span>
          <StatusBadge status={proposal.status} />
        </div>

        {/* Subtitle */}
        {!isCollapsed && (
          <div className="border-t border-border-subtle px-3 py-1.5">
            <p className="text-[11px] text-text-tertiary leading-relaxed">
              {proposal.reason ?? t(manifest.descriptionKey)}
            </p>
          </div>
        )}

        {/* Actions */}
        {proposal.status === 'proposed' && (
          <div className="border-t border-border-subtle px-3 py-2 flex items-center gap-2">
            <button
              onClick={openModal}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-accent/15 text-accent hover:bg-accent/25 cursor-pointer"
            >
              <Plug size={11} />
              {t('integrations.card.connectButton')}
            </button>
            {manifest.docsUrl && (
              <button
                onClick={() => window.cerebro.shell.openExternal(manifest.docsUrl!)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 cursor-pointer"
              >
                <ExternalLink size={11} />
                {t('integrations.card.learnMore')}
              </button>
            )}
            <button
              onClick={handleDismiss}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 cursor-pointer ml-auto"
            >
              <X size={11} />
              {t('integrations.card.dismissButton')}
            </button>
          </div>
        )}

        {proposal.status === 'connecting' && (
          <div className="border-t border-border-subtle px-3 py-2 flex items-center gap-2">
            <button
              onClick={openModal}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-accent/15 text-accent hover:bg-accent/25 cursor-pointer"
            >
              {t('integrations.card.reopen')}
            </button>
          </div>
        )}

        {proposal.status === 'connected' && (
          <div className="border-t border-border-subtle px-3 py-2">
            <span className="flex items-center gap-1.5 text-[11px] text-green-400 font-medium">
              <CheckCircle2 size={12} />
              {t('integrations.card.connectedSubtitle')}
            </span>
          </div>
        )}
      </div>

      {/* Per-provider modal */}
      {modalOpen && (
        <Suspense fallback={null}>
          {manifest.customModalId === 'telegram' && (
            <TelegramConnectModal onClose={closeModal} onPersisted={() => { /* status poll handles it */ }} />
          )}
          {manifest.customModalId === 'hubspot' && (
            <HubSpotConnectModal onClose={closeModal} onPersisted={() => { /* status poll handles it */ }} />
          )}
          {manifest.customModalId === 'whatsapp' && (
            <WhatsAppConnectModal onClose={closeModal} onPersisted={() => { /* status poll handles it */ }} />
          )}
          {!manifest.customModalId && (
            <GenericConnectModal manifest={manifest} onClose={closeModal} />
          )}
        </Suspense>
      )}
    </>
  );
}
