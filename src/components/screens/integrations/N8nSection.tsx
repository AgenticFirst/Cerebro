/**
 * Inline card body for the n8n managed instance (Settings → Integrations).
 * Phase-driven: Install CTA → streamed npm log → provisioning → running with
 * version + Open Flows. All lifecycle goes through window.cerebro.n8n.
 */

import { useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Play, Square, Workflow, ExternalLink } from 'lucide-react';
import clsx from 'clsx';
import N8nNodeRequiredNotice from './N8nNodeRequiredNotice';
import { useN8nStatus } from '../../../hooks/useN8nStatus';
import { useChat } from '../../../context/ChatContext';

export default function N8nSection() {
  const { t } = useTranslation();
  const { setActiveScreen } = useChat();
  const { status, installLog, installing, installAndStart, cancelInstall, start, stop } =
    useN8nStatus();

  const phase = status?.phase ?? 'not_installed';
  const busy = phase === 'installing' || phase === 'starting' || phase === 'provisioning';

  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [installLog]);

  const phaseLabel = useMemo(() => {
    switch (phase) {
      case 'running':
        return t('n8nSetup.statusRunning');
      case 'installing':
        return t('n8nSetup.statusInstalling');
      case 'starting':
        return t('n8nSetup.statusStarting');
      case 'provisioning':
        return t('n8nSetup.statusProvisioning');
      case 'crashed':
        return t('n8nSetup.statusCrashed');
      case 'node_required':
        return t('n8nSetup.statusNodeRequired');
      case 'stopped':
        return t('n8nSetup.statusStopped');
      default:
        return t('n8nSetup.statusNotInstalled');
    }
  }, [phase, t]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary leading-relaxed">
        {t('n8nSetup.sectionDescription')}
      </p>

      <div className="flex items-center gap-3 text-sm">
        <span className="text-text-tertiary">{t('n8nSetup.status')}:</span>
        <span
          className={clsx(
            'flex items-center gap-1.5 font-medium',
            phase === 'running' && 'text-emerald-400',
            (phase === 'crashed' || phase === 'node_required') && 'text-red-400',
            busy && 'text-accent',
            (phase === 'stopped' || phase === 'not_installed') && 'text-text-secondary',
          )}
        >
          {busy && <Loader2 size={12} className="animate-spin" />}
          {phase === 'running' && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />}
          {phaseLabel}
        </span>
        {status?.version && phase === 'running' && (
          <span className="text-xs text-text-tertiary">
            {t('n8nSetup.version')} {status.version}
          </span>
        )}
      </div>

      {phase === 'node_required' && <N8nNodeRequiredNotice />}

      {phase === 'crashed' && status?.lastError && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5 break-words">
          {status.lastError}
        </div>
      )}

      {(phase === 'installing' || (installing && installLog.length > 0)) && (
        <div
          ref={logRef}
          className="bg-black/40 border border-border-subtle rounded-lg px-3 py-2 h-32 overflow-y-auto font-mono text-[10px] text-text-tertiary whitespace-pre-wrap"
        >
          {installLog.join('\n')}
        </div>
      )}

      <div className="flex items-center gap-2">
        {(phase === 'not_installed' || phase === 'node_required') && (
          <button
            onClick={() => void installAndStart()}
            disabled={installing}
            className="flex items-center gap-1.5 text-xs font-medium bg-accent/15 text-accent hover:bg-accent/25 px-3 py-1.5 rounded-md transition-colors disabled:opacity-50"
          >
            <Workflow size={12} />
            {t('n8nSetup.install')}
          </button>
        )}
        {phase === 'installing' && (
          <button
            onClick={cancelInstall}
            className="text-xs font-medium text-text-secondary hover:text-text-primary px-3 py-1.5 rounded-md border border-border-subtle transition-colors"
          >
            {t('n8nSetup.step2CancelInstall')}
          </button>
        )}
        {(phase === 'stopped' || phase === 'crashed') && (
          <button
            onClick={() => void start()}
            className="flex items-center gap-1.5 text-xs font-medium bg-accent/15 text-accent hover:bg-accent/25 px-3 py-1.5 rounded-md transition-colors"
          >
            <Play size={12} />
            {t('n8nSetup.start')}
          </button>
        )}
        {phase === 'running' && (
          <>
            <button
              onClick={() => setActiveScreen('flows')}
              className="flex items-center gap-1.5 text-xs font-medium bg-accent/15 text-accent hover:bg-accent/25 px-3 py-1.5 rounded-md transition-colors"
            >
              <ExternalLink size={12} />
              {t('n8nSetup.openFlows')}
            </button>
            <button
              onClick={() => void stop()}
              className="flex items-center gap-1.5 text-xs font-medium text-text-secondary hover:text-text-primary px-3 py-1.5 rounded-md border border-border-subtle transition-colors"
            >
              <Square size={12} />
              {t('n8nSetup.stop')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
