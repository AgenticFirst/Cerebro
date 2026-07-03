/**
 * Auto-progressing setup modal for the Cerebro-managed n8n instance.
 * Unlike every other connect modal there is nothing to paste — steps advance
 * on the manager's live phase:
 *   1. Explain what's about to happen (local install, no data leaves machine)
 *   2. Streaming npm install log
 *   3. Starting + provisioning spinner
 *   4. Ready → "Open Flows"
 * Mirrors WhatsAppConnectModal's status-driven step pattern.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Download, Loader2, Sparkles, Workflow, X } from 'lucide-react';
import clsx from 'clsx';
import N8nNodeRequiredNotice from './N8nNodeRequiredNotice';
import { useN8nStatus } from '../../../hooks/useN8nStatus';
import { useChat } from '../../../context/ChatContext';

type Step = 1 | 2 | 3 | 4;
const STEP_COUNT = 4;

interface N8nConnectModalProps {
  onClose: () => void;
  onPersisted?: () => void;
}

export default function N8nConnectModal({ onClose, onPersisted }: N8nConnectModalProps) {
  const { t } = useTranslation();
  const { setActiveScreen } = useChat();
  const { status, installLog, installAndStart, cancelInstall } = useN8nStatus();
  const [startError, setStartError] = useState<string | null>(null);
  const kickedOff = useRef(false);

  const phase = status?.phase ?? 'not_installed';

  // Phase → step. The user only drives step 1; everything else follows the manager.
  const step: Step = useMemo(() => {
    if (phase === 'running') return 4;
    if (phase === 'starting' || phase === 'provisioning') return 3;
    if (phase === 'installing') return 2;
    return 1;
  }, [phase]);

  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [installLog]);

  useEffect(() => {
    if (phase === 'running') onPersisted?.();
  }, [phase, onPersisted]);

  const handleInstall = async () => {
    if (kickedOff.current) return;
    kickedOff.current = true;
    setStartError(null);
    const res = await installAndStart();
    kickedOff.current = false;
    if (!res.ok) setStartError(res.error ?? t('n8nSetup.errorTitle'));
  };

  const handleClose = () => {
    if (phase === 'installing') cancelInstall();
    onClose();
  };

  const stepIcon = useMemo(() => {
    switch (step) {
      case 1:
        return <Sparkles size={20} />;
      case 2:
        return <Download size={20} />;
      case 3:
        return <Loader2 size={20} className="animate-spin" />;
      case 4:
        return <CheckCircle2 size={20} />;
      default:
        return <Workflow size={20} />;
    }
  }, [step]);

  const nodeRequired = phase === 'node_required';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={handleClose} />

      <div className="relative bg-bg-surface border border-border-subtle rounded-xl shadow-2xl w-full max-w-lg mx-4 animate-fade-in flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="px-6 pt-5 pb-4 border-b border-border-subtle">
          <button
            onClick={handleClose}
            className="absolute top-3 right-3 p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
            aria-label={t('n8nSetup.cancel')}
          >
            <X size={14} />
          </button>

          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-pink-500/15 text-pink-400 flex items-center justify-center flex-shrink-0">
              {stepIcon}
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
                {t('n8nSetup.stepLabel', { current: step, total: STEP_COUNT })}
              </div>
              <h3 className="text-base font-medium text-text-primary mt-0.5 truncate">
                {t(`n8nSetup.step${step}Title`)}
              </h3>
            </div>
          </div>

          {/* Step dots */}
          <div className="mt-4 flex items-center gap-1.5">
            {Array.from({ length: STEP_COUNT }).map((_, i) => (
              <div
                key={i}
                className={clsx(
                  'h-1 rounded-full transition-all',
                  i + 1 < step && 'flex-1 bg-accent/70',
                  i + 1 === step && 'flex-[2] bg-accent',
                  i + 1 > step && 'flex-1 bg-white/10',
                )}
              />
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5 overflow-y-auto flex-1">
          {step === 1 && (
            <div className="space-y-4">
              <p className="text-sm text-text-secondary leading-relaxed">
                {t('n8nSetup.step1Body')}
              </p>
              <ul className="space-y-2 text-sm text-text-secondary">
                {[
                  t('n8nSetup.step1Point1'),
                  t('n8nSetup.step1Point2'),
                  t('n8nSetup.step1Point3'),
                ].map((point, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <CheckCircle2 size={14} className="text-accent flex-shrink-0 mt-0.5" />
                    <span className="leading-relaxed">{point}</span>
                  </li>
                ))}
              </ul>

              {nodeRequired && <N8nNodeRequiredNotice />}
              {startError && !nodeRequired && (
                <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5 break-words">
                  {startError}
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <p className="text-sm text-text-secondary leading-relaxed">
                {t('n8nSetup.step2Body')}
              </p>
              <div
                ref={logRef}
                className="bg-black/40 border border-border-subtle rounded-lg px-3 py-2 h-44 overflow-y-auto font-mono text-[10px] text-text-tertiary whitespace-pre-wrap"
              >
                {installLog.join('\n')}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 size={28} className="animate-spin text-accent" />
              <p className="text-sm text-text-secondary text-center leading-relaxed">
                {t('n8nSetup.step3Body')}
              </p>
            </div>
          )}

          {step === 4 && (
            <div className="flex flex-col items-center gap-3 py-6">
              <CheckCircle2 size={32} className="text-emerald-400" />
              <p className="text-sm text-text-secondary text-center leading-relaxed">
                {t('n8nSetup.step4Body')}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border-subtle flex items-center justify-end gap-2">
          {step === 1 && (
            <button
              onClick={() => void handleInstall()}
              className="flex items-center gap-1.5 text-sm font-medium bg-accent text-black hover:bg-accent/90 px-4 py-2 rounded-md transition-colors"
            >
              <Download size={14} />
              {t('n8nSetup.step1Install')}
            </button>
          )}
          {step === 2 && (
            <button
              onClick={handleClose}
              className="text-sm font-medium text-text-secondary hover:text-text-primary px-4 py-2 rounded-md border border-border-subtle transition-colors"
            >
              {t('n8nSetup.step2CancelInstall')}
            </button>
          )}
          {step === 4 && (
            <>
              <button
                onClick={handleClose}
                className="text-sm font-medium text-text-secondary hover:text-text-primary px-4 py-2 rounded-md border border-border-subtle transition-colors"
              >
                {t('n8nSetup.close')}
              </button>
              <button
                onClick={() => {
                  setActiveScreen('flows');
                  onClose();
                }}
                className="flex items-center gap-1.5 text-sm font-medium bg-accent text-black hover:bg-accent/90 px-4 py-2 rounded-md transition-colors"
              >
                <Workflow size={14} />
                {t('n8nSetup.step4OpenFlows')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
