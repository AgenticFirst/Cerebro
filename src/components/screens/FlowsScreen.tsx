/**
 * Flows (n8n) — the embedded n8n editor, full width.
 *
 * The genuine n8n canvas in an iframe (pixel-identical to upstream n8n; the
 * local instance serves it, branding intact per the Sustainable Use License).
 * Iframe sandbox modeled on LivePreview. Chat-driven flow building happens
 * from the regular Chat screen; the canvas here follows along.
 *
 * Live canvas follow: when a chat/routine action creates or updates a
 * workflow, the manager emits N8N_WORKFLOW_TOUCHED and we navigate the iframe
 * to that workflow so the user watches the flow appear as it's built. If this
 * screen wasn't mounted at event time, openEditor hands back a one-shot
 * workflowId so we still land on it.
 *
 * The iframe src comes from N8N_OPEN_EDITOR, which strips frame-blocking
 * headers for the n8n origin and injects the session cookie per-request — the
 * editor never shows a login screen.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2, Play, RotateCcw, Workflow } from 'lucide-react';
import N8nConnectModal from './integrations/N8nConnectModal';
import { useN8nStatus } from '../../hooks/useN8nStatus';

export default function FlowsScreen() {
  const { t } = useTranslation();
  const { status, start } = useN8nStatus();
  const [setupOpen, setSetupOpen] = useState(false);
  const [editorSrc, setEditorSrc] = useState<string | null>(null);
  // Bumped to force an iframe remount when the same workflow is updated.
  const [editorBump, setEditorBump] = useState(0);
  const [editorError, setEditorError] = useState<string | null>(null);

  const phase = status?.phase ?? 'not_installed';

  // Prepare the editor (header stripping + cookie plant) whenever n8n comes up.
  useEffect(() => {
    if (phase !== 'running') {
      setEditorSrc(null);
      return;
    }
    let cancelled = false;
    void window.cerebro.n8n.openEditor().then((res) => {
      if (cancelled) return;
      if (res.ok && res.editorUrl) {
        setEditorError(null);
        // A pending workflowId means chat created/edited a flow while this
        // screen wasn't mounted — land the canvas straight on it.
        if (res.workflowId) {
          setEditorSrc(`${res.editorUrl}/workflow/${res.workflowId}`);
          setEditorBump((b) => b + 1);
        } else {
          setEditorSrc((prev) => prev ?? `${res.editorUrl}/home/workflows`);
        }
      } else {
        setEditorError(res.error ?? t('flows.editorLoadError'));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [phase, t]);

  // Follow chat-created/edited workflows on the canvas.
  useEffect(() => {
    return window.cerebro.n8n.onWorkflowTouched(({ workflowId }) => {
      void window.cerebro.n8n.openEditor().then((res) => {
        if (res.ok && res.editorUrl) {
          setEditorSrc(`${res.editorUrl}/workflow/${workflowId}`);
          setEditorBump((b) => b + 1);
        }
      });
    });
  }, []);

  // A stopped-but-installed engine starts itself when the user lands here —
  // visiting Flows *is* the explicit trigger.
  useEffect(() => {
    if (phase === 'stopped') void start();
  }, [phase, start]);

  const renderCanvas = () => {
    if (phase === 'running' && editorSrc && !editorError) {
      return (
        <iframe
          key={`${editorSrc}#${editorBump}`}
          src={editorSrc}
          className="w-full h-full border-0 bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads allow-popups-to-escape-sandbox"
          title="n8n"
        />
      );
    }

    const stateCard = (
      icon: React.ReactNode,
      title: string,
      body: string,
      action?: { label: string; onClick: () => void },
    ) => (
      <div className="h-full flex items-center justify-center p-8">
        <div className="max-w-md text-center space-y-3">
          <div className="flex justify-center">{icon}</div>
          <h2 className="text-base font-medium text-text-primary">{title}</h2>
          <p className="text-sm text-text-secondary leading-relaxed">{body}</p>
          {action && (
            <button
              onClick={action.onClick}
              className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium bg-accent/15 text-accent hover:bg-accent/25 px-4 py-2 rounded-md transition-colors"
            >
              <Play size={14} />
              {action.label}
            </button>
          )}
        </div>
      </div>
    );

    if (phase === 'not_installed' || phase === 'node_required') {
      return stateCard(
        <Workflow size={32} className="text-accent" />,
        t('flows.notInstalledTitle'),
        t('flows.notInstalledBody'),
        { label: t('flows.installCta'), onClick: () => setSetupOpen(true) },
      );
    }
    if (phase === 'installing') {
      return stateCard(
        <Loader2 size={32} className="animate-spin text-accent" />,
        t('flows.installingTitle'),
        t('flows.installingBody'),
      );
    }
    if (phase === 'starting' || phase === 'provisioning' || (phase === 'running' && !editorSrc)) {
      return stateCard(
        <Loader2 size={32} className="animate-spin text-accent" />,
        t('flows.startingTitle'),
        t('flows.startingBody'),
      );
    }
    if (phase === 'crashed' || editorError) {
      return stateCard(
        <AlertTriangle size={32} className="text-red-400" />,
        t('flows.crashedTitle'),
        editorError ?? status?.lastError ?? t('flows.crashedBody'),
        { label: t('flows.retryCta'), onClick: () => void start() },
      );
    }
    // stopped — auto-start is in flight; show the starting state.
    return stateCard(
      <Loader2 size={32} className="animate-spin text-accent" />,
      t('flows.startingTitle'),
      t('flows.startingBody'),
    );
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border-subtle flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-6 h-6 rounded-md bg-accent/15 text-accent flex items-center justify-center flex-shrink-0">
            <Workflow size={13} />
          </div>
          <h1 className="text-sm font-medium text-text-primary truncate">{t('flows.title')}</h1>
          <span className="text-xs text-text-tertiary truncate hidden md:block">
            {t('flows.subtitle')}
          </span>
        </div>
        <div className="flex-1" />
        {phase === 'crashed' && (
          <button
            onClick={() => void start()}
            className="flex items-center gap-1.5 text-xs font-medium text-red-400 hover:text-red-300 px-2.5 py-1 rounded-md border border-red-500/30 transition-colors"
          >
            <RotateCcw size={12} />
            {t('flows.retryCta')}
          </button>
        )}
      </div>

      {/* Full-width n8n canvas */}
      <div className="flex-1 min-w-0 min-h-0">{renderCanvas()}</div>

      {setupOpen && <N8nConnectModal onClose={() => setSetupOpen(false)} />}
    </div>
  );
}
