import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  KeyRound,
  ExternalLink,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  RotateCw,
} from 'lucide-react';
import clsx from 'clsx';
import { useChat } from '../../context/ChatContext';
import type { ClaudeCodeLoginSnapshot } from '../../types/ipc';

interface ClaudeCodeLoginCardProps {
  conversationId: string;
  messageId: string;
}

/**
 * Inline recovery card rendered in place of the raw error string when a
 * Claude Code run ends with `errorClass === 'auth'`. Starts the in-process
 * login orchestrator (`claude /login` via PTY), surfaces the captured
 * URL as a one-click button, and — once auth completes — resends the
 * failed user message automatically.
 *
 * Replaces the old AuthRecoveryCard that opened a host terminal. Users
 * never have to drop to a shell, which is the whole point of fixing the
 * "run `claude` in a terminal" message that used to leak into Slack.
 */
export default function ClaudeCodeLoginCard({
  conversationId,
  messageId,
}: ClaudeCodeLoginCardProps) {
  const { t } = useTranslation();
  const { conversations, regenerateFromUserMessage } = useChat();

  const [snapshot, setSnapshot] = useState<ClaudeCodeLoginSnapshot | null>(null);
  const [starting, setStarting] = useState(false);
  const [submittingCode, setSubmittingCode] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Guard against double-firing the retry when the orchestrator emits
  // multiple 'success' updates (e.g. once from start(), once from cancel).
  const retryFiredRef = useRef(false);

  const resendFailedMessage = useCallback(async () => {
    if (retryFiredRef.current) return;
    retryFiredRef.current = true;
    const conv = conversations.find((c) => c.id === conversationId);
    if (!conv) return;
    const idx = conv.messages.findIndex((m) => m.id === messageId);
    if (idx <= 0) return;
    const prior = [...conv.messages.slice(0, idx)].reverse().find((m) => m.role === 'user');
    if (!prior) return;
    await regenerateFromUserMessage(prior.id);
  }, [conversationId, conversations, messageId, regenerateFromUserMessage]);

  useEffect(() => {
    const unsubscribe = window.cerebro.claudeCode.login.onEvent((snap) => {
      setSnapshot(snap);
      if (snap.status === 'success') {
        void resendFailedMessage();
      }
    });
    return unsubscribe;
  }, [resendFailedMessage]);

  const handleStart = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      const snap = await window.cerebro.claudeCode.login.start('oauth');
      setSnapshot(snap);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }, []);

  const handleOpenUrl = useCallback(async () => {
    if (!snapshot?.url) return;
    try {
      await window.cerebro.shell.openExternal(snapshot.url);
    } catch {
      /* noop */
    }
  }, [snapshot]);

  const handleSubmitCode = useCallback(async () => {
    if (!snapshot || !code.trim()) return;
    setSubmittingCode(true);
    setError(null);
    try {
      const snap = await window.cerebro.claudeCode.login.submitCode(snapshot.loginId, code.trim());
      setSnapshot(snap);
      if (snap.status === 'failure') {
        setError(snap.reason ?? t('chat.claudeCodeLogin.codeFailed'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingCode(false);
    }
  }, [code, snapshot, t]);

  const handleRetryFromScratch = useCallback(async () => {
    setError(null);
    setSnapshot(null);
    setCode('');
    retryFiredRef.current = false;
    try {
      await window.cerebro.claudeCode.login.cancel();
    } catch {
      /* noop */
    }
    await handleStart();
  }, [handleStart]);

  // ── Render ─────────────────────────────────────────────────────────

  const status = snapshot?.status ?? null;
  const isBusy = starting || status === 'starting' || status === 'submitting-code';
  const showCodeInput = snapshot?.requiresCode && status === 'awaiting-user';
  const isDone = status === 'success';
  const isFailed = status === 'failure' || status === 'cancelled';

  return (
    <div
      className={clsx(
        'mb-2 rounded-xl border px-3.5 py-3',
        isDone
          ? 'border-emerald-500/40 bg-emerald-500/[0.06]'
          : 'border-amber-500/40 bg-amber-500/[0.06]',
      )}
      data-testid="claude-code-login-card"
    >
      <div className="flex items-start gap-2.5">
        <div className="flex-shrink-0 mt-0.5">
          {isDone ? (
            <CheckCircle2 size={16} className="text-emerald-400" strokeWidth={2} />
          ) : (
            <KeyRound size={16} className="text-amber-400" strokeWidth={2} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-text-primary">
            {isDone ? t('chat.claudeCodeLogin.successTitle') : t('chat.claudeCodeLogin.title')}
          </h3>
          <p className="mt-0.5 text-xs text-text-secondary leading-relaxed">
            {isDone ? t('chat.claudeCodeLogin.successBody') : t('chat.claudeCodeLogin.body')}
          </p>

          {/* Initial state — no login started yet */}
          {!snapshot && !isDone && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleStart}
                disabled={starting}
                className={clsx(
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium',
                  'bg-accent text-bg-base hover:bg-accent-hover transition-colors',
                  'disabled:opacity-40 disabled:cursor-not-allowed',
                )}
              >
                {starting ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <ExternalLink size={12} strokeWidth={2} />
                )}
                <span>{t('chat.claudeCodeLogin.startButton')}</span>
              </button>
            </div>
          )}

          {/* URL captured — clickable link */}
          {snapshot?.url && !isDone && !isFailed && (
            <div className="mt-2.5">
              <button
                type="button"
                onClick={handleOpenUrl}
                className={clsx(
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium',
                  'bg-accent text-bg-base hover:bg-accent-hover transition-colors',
                )}
              >
                <ExternalLink size={12} strokeWidth={2} />
                <span>{t('chat.claudeCodeLogin.openLinkButton')}</span>
              </button>
              <div className="mt-1.5 break-all text-[11px] text-text-tertiary font-mono">
                {snapshot.url}
              </div>
            </div>
          )}

          {/* Awaiting browser callback (oauth) — no URL printed */}
          {snapshot && !snapshot.url && status === 'awaiting-user' && !showCodeInput && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-text-tertiary">
              <Loader2 size={11} className="animate-spin" />
              <span>{t('chat.claudeCodeLogin.waitingBrowser')}</span>
            </div>
          )}

          {/* Paste-back code input (setup-token) */}
          {showCodeInput && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t('chat.claudeCodeLogin.codePlaceholder')}
                className={clsx(
                  'flex-1 min-w-[180px] rounded-md border border-border-subtle bg-bg-base/60',
                  'px-2.5 py-1 text-xs text-text-primary placeholder:text-text-tertiary',
                  'focus:outline-none focus:border-accent/60',
                )}
                disabled={submittingCode}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSubmitCode();
                }}
              />
              <button
                type="button"
                onClick={handleSubmitCode}
                disabled={submittingCode || !code.trim()}
                className={clsx(
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium',
                  'bg-accent text-bg-base hover:bg-accent-hover transition-colors',
                  'disabled:opacity-40 disabled:cursor-not-allowed',
                )}
              >
                {submittingCode ? <Loader2 size={12} className="animate-spin" /> : null}
                <span>{t('chat.claudeCodeLogin.submitCodeButton')}</span>
              </button>
            </div>
          )}

          {/* Submitting code — verifying */}
          {status === 'submitting-code' && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-text-tertiary">
              <Loader2 size={11} className="animate-spin" />
              <span>{t('chat.claudeCodeLogin.verifying')}</span>
            </div>
          )}

          {/* Failed — retry button */}
          {isFailed && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleRetryFromScratch}
                disabled={isBusy}
                className={clsx(
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium',
                  'border border-border-subtle bg-bg-base/60 text-text-secondary',
                  'hover:bg-bg-hover hover:text-text-primary transition-colors',
                  'disabled:opacity-40 disabled:cursor-not-allowed',
                )}
              >
                <RotateCw size={12} strokeWidth={2} />
                <span>{t('chat.claudeCodeLogin.retryButton')}</span>
              </button>
            </div>
          )}

          {(() => {
            const hint = error ?? (status === 'failure' ? snapshot?.reason : null);
            if (!hint) return null;
            return (
              <div className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-300/90">
                <AlertTriangle size={11} strokeWidth={2} className="flex-shrink-0 mt-0.5" />
                <span>{hint}</span>
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
