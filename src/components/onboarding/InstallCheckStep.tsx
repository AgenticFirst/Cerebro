/**
 * Post-tour gate: verifies the Claude Code CLI is installed on the user's
 * machine. Cerebro's inference path is Claude-Code-only — without it the
 * app effectively does nothing.
 *
 * Lifecycle:
 *   1. `checking`: re-runs detection on mount. If `available`, immediately
 *      advances (the user never sees this step). Otherwise → `prompt`.
 *   2. `prompt`: friendly card explaining what's needed, with three CTAs:
 *      - "Install for me" → triggers the IPC installer (Anthropic's
 *        official curl script run in a login bash shell).
 *      - "Verify installation" (under a manual-instructions disclosure)
 *        → re-runs detection without installing.
 *      - "I'll install later" → advances anyway; the existing chat-block
 *        modal in ChatContext continues to nag.
 *   3. `installing`: live log panel + cancel button.
 *   4. `success`: brief check + auto-advance.
 *   5. `failure`: stderr tail + retry / open-docs / skip.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Brain,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import type { ClaudeCodeInstallResult } from '../../types/ipc';

const INSTALL_CMD = 'curl -fsSL https://claude.ai/install.sh | bash';
const DOCS_URL = 'https://docs.claude.com/en/docs/claude-code/setup';
const SUCCESS_DWELL_MS = 1200;

type Phase = 'checking' | 'prompt' | 'installing' | 'success' | 'failure';

interface InstallCheckStepProps {
  /** Advance to the next tour step (celebration). In standalone mode this is
   *  the close-everything callback (skips celebration entirely). */
  onAdvance: () => void;
  /** Marks `claude_code_install_seen=true` in persistence. Called once when
   *  the step renders any visible UI for the first time. */
  onSeen: () => void;
  /** True when this step is rendered outside the full tour (existing user
   *  who already finished onboarding but still has the CLI missing). Hides
   *  the spotlight backdrop in favor of a centered modal. */
  standalone?: boolean;
}

export default function InstallCheckStep({
  onAdvance,
  onSeen,
  standalone,
}: InstallCheckStepProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('checking');
  const [logLines, setLogLines] = useState<string[]>([]);
  const [outputTail, setOutputTail] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [copied, setCopied] = useState(false);

  // Guard against double-advance on rapid state transitions.
  const advancedRef = useRef(false);
  const advance = useCallback(() => {
    if (advancedRef.current) return;
    advancedRef.current = true;
    onAdvance();
  }, [onAdvance]);

  // Step 1: re-run detection on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await window.cerebro.claudeCode.detect();
        if (cancelled) return;
        if (info.status === 'available') {
          // Silent pass — never render UI.
          advance();
          return;
        }
      } catch {
        // Detection itself failed — fall through to prompt anyway.
      }
      if (cancelled) return;
      onSeen();
      setPhase('prompt');
    })();
    return () => {
      cancelled = true;
    };
  }, [advance, onSeen]);

  const startInstall = useCallback(async () => {
    setLogLines([]);
    setPhase('installing');
    let result: ClaudeCodeInstallResult;
    try {
      result = await window.cerebro.claudeCode.install((line) => {
        setLogLines((prev) => {
          const next = [...prev, line];
          // Keep the panel cheap to render — last 500 lines is plenty.
          return next.length > 500 ? next.slice(-500) : next;
        });
      });
    } catch (err) {
      setOutputTail(err instanceof Error ? err.message : String(err));
      setPhase('failure');
      return;
    }
    setOutputTail(result.outputTail);
    if (result.ok) {
      setPhase('success');
      setTimeout(advance, SUCCESS_DWELL_MS);
    } else {
      setPhase('failure');
    }
  }, [advance]);

  const cancelInstall = useCallback(async () => {
    await window.cerebro.claudeCode.cancelInstall();
    setPhase('prompt');
  }, []);

  const verifyOnly = useCallback(async () => {
    setPhase('checking');
    try {
      const info = await window.cerebro.claudeCode.detect();
      if (info.status === 'available') {
        setPhase('success');
        setTimeout(advance, SUCCESS_DWELL_MS);
        return;
      }
    } catch {
      /* fall through */
    }
    setPhase('prompt');
  }, [advance]);

  const copyCommand = useCallback(async () => {
    await navigator.clipboard.writeText(INSTALL_CMD);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }, []);

  const openDocs = useCallback(() => {
    void window.cerebro.shell.openExternal(DOCS_URL);
  }, []);

  // Skip / dismiss link: in tour mode advances to celebration; in standalone
  // mode the parent passes a close-only callback.
  const handleSkip = useCallback(() => advance(), [advance]);

  // Auto-scroll the log to the latest line as install progresses.
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logLines]);

  // While checking we render NOTHING — the dim layer stays put but no card.
  if (phase === 'checking') {
    return (
      <>
        <div
          className="fixed inset-0 z-[10000] bg-black/65 backdrop-blur-[2px]"
          aria-hidden
        />
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-0 z-[10001] flex items-center justify-center pointer-events-none"
        >
          <div className="flex items-center gap-2 text-text-tertiary text-[12px]">
            <Loader2 size={14} className="animate-spin" />
            <span>{t('onboarding.installCheck.checking')}</span>
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div className="relative w-full max-w-md mx-4 bg-bg-elevated border border-border-subtle rounded-2xl shadow-2xl animate-tour-card-in overflow-hidden">
        {/* Subtle accent header glow */}
        <div
          className="absolute top-0 left-0 right-0 h-32 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 60% 80% at 50% 0%, rgba(6,182,212,0.18), transparent 70%)',
          }}
        />

        {/* Header (icon + dismiss in standalone) */}
        <div className="relative px-6 pt-6 pb-2 flex items-start gap-3">
          <div
            className={clsx(
              'flex items-center justify-center w-10 h-10 rounded-xl border flex-shrink-0',
              phase === 'success'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                : phase === 'failure'
                  ? 'bg-red-500/10 border-red-500/30 text-red-400'
                  : 'bg-accent/15 border-accent/30 text-accent',
            )}
          >
            {phase === 'success' ? (
              <Check size={20} strokeWidth={2.2} />
            ) : phase === 'failure' ? (
              <X size={20} strokeWidth={2.2} />
            ) : phase === 'installing' ? (
              <Loader2 size={20} className="animate-spin" />
            ) : (
              <Brain size={20} strokeWidth={1.8} />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-[17px] font-semibold text-text-primary leading-tight">
              {phase === 'prompt' && t('onboarding.installCheck.prompt.title')}
              {phase === 'installing' && t('onboarding.installCheck.installing.title')}
              {phase === 'success' && t('onboarding.installCheck.success.title')}
              {phase === 'failure' && t('onboarding.installCheck.failure.title')}
            </h1>
            <p className="text-[12.5px] text-text-secondary leading-relaxed mt-1">
              {phase === 'prompt' && t('onboarding.installCheck.prompt.body')}
              {phase === 'installing' && t('onboarding.installCheck.installing.body')}
              {phase === 'success' && t('onboarding.installCheck.success.body')}
              {phase === 'failure' && t('onboarding.installCheck.failure.body')}
            </p>
          </div>
        </div>

        {/* PROMPT */}
        {phase === 'prompt' && (
          <div className="px-6 pt-4 pb-5 space-y-3">
            <button
              onClick={startInstall}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-accent text-bg-base text-[14px] font-semibold hover:bg-accent-hover transition-colors cursor-pointer"
            >
              <Sparkles size={15} strokeWidth={2.2} />
              {t('onboarding.installCheck.prompt.installCta')}
            </button>

            <details
              open={showManual}
              onToggle={(e) => setShowManual((e.target as HTMLDetailsElement).open)}
              className="group"
            >
              <summary className="cursor-pointer text-[12px] text-text-secondary hover:text-text-primary py-1 select-none list-none flex items-center gap-1.5">
                <span className="transition-transform group-open:rotate-90">›</span>
                {t('onboarding.installCheck.prompt.manualToggle')}
              </summary>
              <div className="mt-2 space-y-2">
                <p className="text-[11.5px] text-text-tertiary leading-relaxed">
                  {t('onboarding.installCheck.prompt.manualBody')}
                </p>
                <div className="flex items-center gap-2 bg-bg-base border border-border-subtle rounded-md px-2.5 py-1.5">
                  <code className="flex-1 text-[11.5px] font-mono text-text-primary truncate">
                    {INSTALL_CMD}
                  </code>
                  <button
                    onClick={copyCommand}
                    className="flex-shrink-0 flex items-center gap-1 text-[11px] text-text-tertiary hover:text-accent transition-colors cursor-pointer"
                  >
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                    {copied
                      ? t('onboarding.installCheck.prompt.copied')
                      : t('onboarding.installCheck.prompt.copy')}
                  </button>
                </div>
                <button
                  onClick={verifyOnly}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-[12px] font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer border border-border-subtle"
                >
                  <RefreshCw size={12} />
                  {t('onboarding.installCheck.prompt.verifyCta')}
                </button>
              </div>
            </details>

            <button
              onClick={handleSkip}
              className="w-full text-[11.5px] text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer pt-1"
            >
              {standalone
                ? t('onboarding.installCheck.prompt.dismissLater')
                : t('onboarding.installCheck.prompt.skipLater')}
            </button>
          </div>
        )}

        {/* INSTALLING */}
        {phase === 'installing' && (
          <div className="px-6 pt-3 pb-5 space-y-3">
            <div
              ref={logRef}
              className="bg-bg-base border border-border-subtle rounded-md p-3 max-h-44 overflow-y-auto scrollbar-thin font-mono text-[11px] leading-relaxed text-text-secondary"
            >
              {logLines.length === 0 ? (
                <span className="text-text-tertiary italic">
                  {t('onboarding.installCheck.installing.starting')}
                </span>
              ) : (
                logLines.map((line, i) => (
                  <div key={i} className="whitespace-pre-wrap break-words">
                    {line}
                  </div>
                ))
              )}
            </div>
            <button
              onClick={cancelInstall}
              className="w-full px-3 py-2 rounded-md text-[12px] font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer border border-border-subtle"
            >
              {t('onboarding.installCheck.installing.cancel')}
            </button>
          </div>
        )}

        {/* SUCCESS — minimal, auto-advances */}
        {phase === 'success' && (
          <div className="px-6 pt-3 pb-6 text-center">
            <p className="text-[12px] text-text-tertiary">
              {t('onboarding.installCheck.success.continuing')}
            </p>
          </div>
        )}

        {/* FAILURE */}
        {phase === 'failure' && (
          <div className="px-6 pt-3 pb-5 space-y-3">
            {outputTail && (
              <div className="bg-bg-base border border-red-500/20 rounded-md p-3 max-h-32 overflow-y-auto scrollbar-thin font-mono text-[10.5px] leading-relaxed text-text-tertiary whitespace-pre-wrap break-words">
                {outputTail}
              </div>
            )}
            <p className="text-[11.5px] text-text-tertiary leading-relaxed">
              {t('onboarding.installCheck.failure.manualHint')}
            </p>
            <div className="flex items-center gap-2 bg-bg-base border border-border-subtle rounded-md px-2.5 py-1.5">
              <code className="flex-1 text-[11.5px] font-mono text-text-primary truncate">
                {INSTALL_CMD}
              </code>
              <button
                onClick={copyCommand}
                className="flex-shrink-0 flex items-center gap-1 text-[11px] text-text-tertiary hover:text-accent transition-colors cursor-pointer"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied
                  ? t('onboarding.installCheck.prompt.copied')
                  : t('onboarding.installCheck.prompt.copy')}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={startInstall}
                className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-[12px] font-semibold bg-accent text-bg-base hover:bg-accent-hover transition-colors cursor-pointer"
              >
                <RefreshCw size={12} />
                {t('onboarding.installCheck.failure.retry')}
              </button>
              <button
                onClick={openDocs}
                className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-[12px] font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer border border-border-subtle"
              >
                <ExternalLink size={12} />
                {t('onboarding.installCheck.failure.openDocs')}
              </button>
            </div>
            <button
              onClick={handleSkip}
              className="w-full text-[11.5px] text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer pt-1"
            >
              {standalone
                ? t('onboarding.installCheck.prompt.dismissLater')
                : t('onboarding.installCheck.prompt.skipLater')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
