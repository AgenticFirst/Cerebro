import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, ExternalLink, RotateCw, AlertTriangle, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { useChat } from '../../context/ChatContext';

interface AuthRecoveryCardProps {
  /** Conversation the failed assistant message lives in — used to locate
   *  the immediately-preceding user prompt for the Retry action. */
  conversationId: string;
  /** ID of the failed assistant message — Retry walks backwards from
   *  here to find the user message to resend. */
  messageId: string;
}

/**
 * Inline recovery card rendered in place of the raw error string when a
 * Claude Code run ends with `errorClass === 'auth'`. Opens a host
 * terminal running `claude` so the user can complete the sign-in flow,
 * then re-probes auth and resends the last user message on Retry.
 *
 * The card never disappears on its own; the user dismisses it implicitly
 * by retrying (which removes the failed assistant message via
 * regenerateFromUserMessage) or by sending a new message.
 */
export default function AuthRecoveryCard({
  conversationId,
  messageId,
}: AuthRecoveryCardProps) {
  const { t } = useTranslation();
  const { conversations, regenerateFromUserMessage } = useChat();
  const [opening, setOpening] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const handleOpenLogin = useCallback(async () => {
    setOpening(true);
    setHint(null);
    try {
      const res = await window.cerebro.claudeCode.openLogin();
      if (!res.ok) {
        setHint(t('chat.authRecovery.openFailed'));
      }
    } catch {
      setHint(t('chat.authRecovery.openFailed'));
    } finally {
      setOpening(false);
    }
  }, [t]);

  const handleRetry = useCallback(async () => {
    setRetrying(true);
    setHint(null);
    try {
      // Force-refresh the cached probe so we get a live answer instead
      // of the 60s-stale "not authenticated" reading we just cleared.
      const probe = await window.cerebro.claudeCode.probeAuth({ force: true });
      if (!probe.ok) {
        setHint(t('chat.authRecovery.stillFailing'));
        return;
      }

      // Find the user message that produced this failed assistant
      // reply (the one immediately above it in the transcript) and
      // resend it. regenerateFromUserMessage truncates everything
      // after it, so the auth-recovery card naturally goes away.
      const conv = conversations.find((c) => c.id === conversationId);
      if (!conv) return;
      const idx = conv.messages.findIndex((m) => m.id === messageId);
      if (idx <= 0) return;
      const prior = [...conv.messages.slice(0, idx)].reverse().find((m) => m.role === 'user');
      if (!prior) return;
      setHint(t('chat.authRecovery.readyHint'));
      await regenerateFromUserMessage(prior.id);
    } finally {
      setRetrying(false);
    }
  }, [conversationId, conversations, messageId, regenerateFromUserMessage, t]);

  return (
    <div
      className={clsx(
        'mb-2 rounded-xl border border-amber-500/40 bg-amber-500/[0.06]',
        'px-3.5 py-3',
      )}
      data-testid="auth-recovery-card"
    >
      <div className="flex items-start gap-2.5">
        <div className="flex-shrink-0 mt-0.5">
          <KeyRound size={16} className="text-amber-400" strokeWidth={2} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-text-primary">
            {t('chat.authRecovery.title')}
          </h3>
          <p className="mt-0.5 text-xs text-text-secondary leading-relaxed">
            {t('chat.authRecovery.body')}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleOpenLogin}
              disabled={opening}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium',
                'bg-accent text-bg-base hover:bg-accent-hover transition-colors',
                'disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              {opening ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <ExternalLink size={12} strokeWidth={2} />
              )}
              <span>{t('chat.authRecovery.signIn')}</span>
            </button>
            <button
              type="button"
              onClick={handleRetry}
              disabled={retrying}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium',
                'border border-border-subtle bg-bg-base/60 text-text-secondary',
                'hover:bg-bg-hover hover:text-text-primary transition-colors',
                'disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              {retrying ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RotateCw size={12} strokeWidth={2} />
              )}
              <span>{retrying ? t('chat.authRecovery.retrying') : t('chat.authRecovery.retry')}</span>
            </button>
          </div>
          {hint && (
            <div className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-300/90">
              <AlertTriangle size={11} strokeWidth={2} className="flex-shrink-0 mt-0.5" />
              <span>{hint}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
