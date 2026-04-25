import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowLeft, ArrowRight, CheckCircle2, Loader2, Plug, Settings2, Sparkles, X } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import type { RoutineTemplate, RequiredConnection } from '../../../types/routine-templates';
import type { CreateRoutineInput } from '../../../types/routines';
import type {
  HubSpotPipelineSummary,
  HubSpotStatusResponse,
  WhatsAppStatusResponse,
  TelegramStatusResponse,
} from '../../../types/ipc';
import { materializeTemplate } from '../../../routine-templates';
import { WhatsAppIcon, HubSpotIcon, TelegramIcon } from '../../icons/BrandIcons';

interface UseTemplateDialogProps {
  template: RoutineTemplate;
  onClose: () => void;
  onCreate: (input: CreateRoutineInput) => Promise<boolean>;
  /** Optional — when provided, the setup banner exposes a "Go to Integrations"
   *  shortcut that closes the dialog and navigates the app there. */
  onOpenIntegrations?: () => void;
}

const CONNECTION_ICON: Partial<Record<RequiredConnection, (p: { size?: number; className?: string }) => JSX.Element>> = {
  whatsapp: WhatsAppIcon,
  hubspot: HubSpotIcon,
  telegram: TelegramIcon,
};

type Step = 1 | 2 | 3;
type ConnectionId = 'whatsapp' | 'hubspot' | 'telegram';

interface ConnectionStatus {
  id: ConnectionId;
  label: string;
  connected: boolean;
  detail: string;
}

export default function UseTemplateDialog({ template, onClose, onCreate, onOpenIntegrations }: UseTemplateDialogProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>(1);
  const [connections, setConnections] = useState<ConnectionStatus[]>([]);
  // When true, the setup-required banner is rendered inside the Preview step.
  // Flipped on by clicking "Use this template" while any required connection
  // is missing; cleared when connections are later detected as ready.
  const [showSetupPrompt, setShowSetupPrompt] = useState(false);
  const [pipelines, setPipelines] = useState<HubSpotPipelineSummary[]>([]);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const v of template.variables) if (v.default !== undefined) init[v.key] = v.default;
    return init;
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // ── Connections check ────────────────────────────────────────
  const refreshConnections = useCallback(async () => {
    const needed = new Set(template.requiredConnections);
    const out: ConnectionStatus[] = [];
    if (needed.has('whatsapp')) {
      const s: WhatsAppStatusResponse = await window.cerebro.whatsapp.status();
      out.push({
        id: 'whatsapp',
        label: t('routineTemplates.waLabel'),
        connected: s.state === 'connected',
        detail: s.state === 'connected'
          ? t('routineTemplates.waConnected', { phone: s.phoneNumber ?? t('routineTemplates.unknownPhone') })
          : t('routineTemplates.waNotConnected'),
      });
    }
    if (needed.has('hubspot')) {
      const s: HubSpotStatusResponse = await window.cerebro.hubspot.status();
      out.push({
        id: 'hubspot',
        label: t('routineTemplates.hsLabel'),
        connected: s.hasToken,
        detail: s.hasToken
          ? t('routineTemplates.hsConnected', { portal: s.portalId ?? t('routineTemplates.unknownPortal') })
          : t('routineTemplates.hsNotConnected'),
      });
    }
    if (needed.has('telegram')) {
      const s: TelegramStatusResponse = await window.cerebro.telegram.status();
      out.push({
        id: 'telegram',
        label: t('routineTemplates.tgLabel'),
        connected: Boolean(s.hasToken),
        detail: s.hasToken
          ? t('routineTemplates.tgConnected', { username: s.botUsername ?? t('routineTemplates.unknownUsername') })
          : t('routineTemplates.tgNotConnected'),
      });
    }
    setConnections((prev) => (sameConnections(prev, out) ? prev : out));
  }, [template.requiredConnections, t]);

  useEffect(() => {
    void refreshConnections();
    // WhatsApp pushes status events; use those to avoid idle polling when the
    // only connection we care about is WA. HubSpot + Telegram don't emit, so
    // we fall back to a coarser poll for those.
    const off = window.cerebro.whatsapp.onStatusChanged(() => { void refreshConnections(); });
    const needsPolling = template.requiredConnections.some((c) => c === 'hubspot' || c === 'telegram');
    const id = needsPolling ? setInterval(refreshConnections, 10_000) : null;
    return () => {
      off();
      if (id) clearInterval(id);
    };
  }, [refreshConnections, template.requiredConnections]);

  // ── Load HubSpot pipelines when HubSpot is required + connected ─
  const hubSpotConnected = connections.find((c) => c.id === 'hubspot')?.connected ?? false;
  useEffect(() => {
    if (!hubSpotConnected) return;
    void (async () => {
      const res = await window.cerebro.hubspot.listPipelines();
      if (res.ok && res.pipelines) setPipelines(res.pipelines);
    })();
  }, [hubSpotConnected]);

  const allConnected = connections.length > 0 && connections.every((c) => c.connected);
  const missingConnections = useMemo(() => connections.filter((c) => !c.connected), [connections]);

  // Auto-clear the setup banner once the user has finished connecting everything
  // (e.g. they clicked "Go to Integrations", paired WhatsApp, came back).
  useEffect(() => {
    if (allConnected && showSetupPrompt) setShowSetupPrompt(false);
  }, [allConnected, showSetupPrompt]);

  const handleAdvanceFromPreview = useCallback(() => {
    if (!allConnected) {
      setShowSetupPrompt(true);
      return;
    }
    setStep(2);
  }, [allConnected]);

  // ── Validation for Customize step ────────────────────────────
  const missingVariables = useMemo(() => {
    return template.variables.filter((v) => {
      if (!v.required) return false;
      const current = values[v.key];
      return !current || !current.trim();
    });
  }, [template.variables, values]);

  // Materialize once per (template, values) change — expensive (JSON.parse +
  // re-stringify) and would otherwise run three times per render of step 3.
  const materialized = useMemo(() => materializeTemplate(template, values), [template, values]);

  // ── Submit ───────────────────────────────────────────────────
  const handleCreate = useCallback(async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const input: CreateRoutineInput = {
        name: materialized.name,
        description: materialized.description,
        dagJson: materialized.dagJson,
        triggerType: materialized.triggerType,
        plainEnglishSteps: materialized.plainEnglishSteps,
        requiredConnections: materialized.requiredConnections,
        source: 'marketplace',
      };
      const ok = await onCreate(input);
      if (ok) onClose();
      else setSubmitError(t('routineTemplates.createFailed'));
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [materialized, onCreate, onClose, t]);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-bg-elevated border border-border-subtle rounded-lg shadow-2xl w-[640px] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border-subtle">
          <div className="w-9 h-9 rounded-lg bg-accent/15 text-accent flex items-center justify-center">
            <Sparkles size={16} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-text-primary truncate">{template.name.replace(/%%\w+%%/g, '…')}</div>
            <div className="text-xs text-text-tertiary">
              {t('routineTemplates.stepCounter', { current: step, total: 3 })}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label={t('routineTemplates.close')}
            className="p-1 rounded text-text-tertiary hover:text-text-secondary"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {step === 1 && (
            <div>
              <p className="text-sm text-text-secondary leading-relaxed mb-5">
                {template.description.replace(/%%\w+%%/g, '…')}
              </p>

              <div className="mb-5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary mb-2">
                  {t('routineTemplates.previewStepsHeader')}
                </div>
                <ol className="space-y-2">
                  {template.plainEnglishSteps.map((s, i) => (
                    <li key={i} className="flex gap-3 text-xs text-text-secondary leading-relaxed">
                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-accent/15 text-accent text-[10px] font-semibold flex items-center justify-center">
                        {i + 1}
                      </span>
                      <span className="pt-0.5">{s.replace(/%%\w+%%/g, '…')}</span>
                    </li>
                  ))}
                </ol>
              </div>

              {connections.length > 0 && (
                <div className="mb-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary mb-2">
                    {t('routineTemplates.previewIntegrationsHeader')}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {connections.map((c) => {
                      const Icon = CONNECTION_ICON[c.id];
                      return (
                        <span
                          key={c.id}
                          title={c.detail}
                          className={clsx(
                            'text-[11px] font-medium px-2 py-1 rounded-full border flex items-center gap-1.5',
                            c.connected
                              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                              : 'border-border-subtle bg-bg-surface text-text-tertiary',
                          )}
                        >
                          {Icon ? <Icon size={11} /> : null}
                          {c.label}
                          {c.connected ? <CheckCircle2 size={10} /> : null}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              {showSetupPrompt && missingConnections.length > 0 && (
                <div className="mt-5 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                  <div className="flex items-start gap-2.5">
                    <AlertCircle size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-text-primary">
                        {t('routineTemplates.setupTitle')}
                      </div>
                      <p className="text-[11px] text-text-tertiary mt-1 leading-relaxed">
                        {t('routineTemplates.setupBody', { count: missingConnections.length })}
                      </p>
                      <ul className="mt-2 space-y-1">
                        {missingConnections.map((c) => (
                          <li key={c.id} className="text-[11px] text-text-secondary flex items-center gap-1.5">
                            <span className="w-1 h-1 rounded-full bg-amber-400" />
                            <span className="font-medium text-text-primary">{c.label}</span>
                            <span className="text-text-tertiary">— {c.detail}</span>
                          </li>
                        ))}
                      </ul>
                      {onOpenIntegrations && (
                        <button
                          type="button"
                          onClick={onOpenIntegrations}
                          className="mt-3 inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 border border-amber-500/30"
                        >
                          <Plug size={11} /> {t('routineTemplates.goToIntegrations')}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div>
              <div className="flex items-center gap-2 text-sm font-medium text-text-primary mb-1">
                <Settings2 size={14} /> {t('routineTemplates.customizeHeader')}
              </div>
              <p className="text-xs text-text-tertiary mb-4 leading-relaxed">
                {t('routineTemplates.customizeBody')}
              </p>
              <div className="space-y-3">
                {template.variables.map((v) => (
                  <VariableInput
                    key={v.key}
                    variable={v}
                    value={values[v.key] ?? ''}
                    pipelines={pipelines}
                    parentPipeline={v.dependsOnVariable ? values[v.dependsOnVariable] : undefined}
                    onChange={(val) => setValues((prev) => ({ ...prev, [v.key]: val }))}
                  />
                ))}
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <div className="flex items-center gap-2 text-sm font-medium text-text-primary mb-1">
                <Sparkles size={14} /> {t('routineTemplates.reviewHeader')}
              </div>
              <p className="text-xs text-text-tertiary mb-4 leading-relaxed">
                {t('routineTemplates.reviewBody')}
              </p>
              <div className="space-y-3 text-xs">
                <ReviewRow label={t('routineTemplates.reviewNameLabel')} value={materialized.name} />
                <ReviewRow label={t('routineTemplates.reviewDescriptionLabel')} value={materialized.description} />
                <div className="rounded-md border border-border-subtle bg-bg-surface p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary mb-2">
                    {t('routineTemplates.reviewWhatItDoes')}
                  </div>
                  <ul className="space-y-1 text-text-secondary leading-relaxed">
                    {materialized.plainEnglishSteps.map((s, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="text-accent">•</span>
                        <span>{s}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                {submitError && (
                  <div className="rounded-md border border-red-500/30 bg-red-500/10 text-red-400 px-3 py-2 text-xs">
                    {submitError}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-border-subtle">
          {step > 1 ? (
            <button
              onClick={() => setStep((s) => Math.max(1, s - 1) as Step)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md text-text-tertiary hover:text-text-secondary"
            >
              <ArrowLeft size={12} /> {t('routineTemplates.back')}
            </button>
          ) : <span />}

          {step === 1 ? (
            <button
              onClick={handleAdvanceFromPreview}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-accent text-white hover:bg-accent-hover"
            >
              <Sparkles size={12} /> {t('routineTemplates.useThisTemplate')}
            </button>
          ) : step === 2 ? (
            <button
              onClick={() => setStep(3)}
              disabled={missingVariables.length > 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('routineTemplates.next')} <ArrowRight size={12} />
            </button>
          ) : (
            <button
              onClick={handleCreate}
              disabled={submitting}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-accent text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {submitting && <Loader2 size={12} className="animate-spin" />}
              {t('routineTemplates.createRoutine')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function sameConnections(a: ConnectionStatus[], b: ConnectionStatus[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false;
    if (a[i].connected !== b[i].connected) return false;
    if (a[i].detail !== b[i].detail) return false;
  }
  return true;
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">{label}</div>
      <div className="mt-1 text-text-primary break-words">{value}</div>
    </div>
  );
}

function VariableInput(props: {
  variable: import('../../../types/routine-templates').TemplateVariable;
  value: string;
  pipelines: HubSpotPipelineSummary[];
  parentPipeline: string | undefined;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  const { variable, value, pipelines, parentPipeline, onChange } = props;

  const labelNode = (
    <label className="block text-xs font-medium text-text-secondary">
      {variable.label}
      {variable.required && <span className="text-red-400 ml-0.5">*</span>}
    </label>
  );

  if (variable.type === 'hubspot_pipeline') {
    return (
      <div>
        {labelNode}
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full h-9 px-3 text-sm bg-bg-surface border border-border-subtle rounded-md text-text-primary focus:outline-none focus:border-accent/50"
        >
          <option value="">{t('routineTemplates.selectPipelinePlaceholder')}</option>
          {pipelines.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        <p className="mt-1 text-[11px] text-text-tertiary">{variable.description}</p>
      </div>
    );
  }

  if (variable.type === 'hubspot_stage') {
    const stages = pipelines.find((p) => p.id === parentPipeline)?.stages ?? [];
    return (
      <div>
        {labelNode}
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={!parentPipeline}
          className="mt-1 w-full h-9 px-3 text-sm bg-bg-surface border border-border-subtle rounded-md text-text-primary focus:outline-none focus:border-accent/50 disabled:opacity-50"
        >
          <option value="">{t('routineTemplates.selectStagePlaceholder')}</option>
          {stages.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
        <p className="mt-1 text-[11px] text-text-tertiary">{variable.description}</p>
      </div>
    );
  }

  if (variable.type === 'select') {
    return (
      <div>
        {labelNode}
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full h-9 px-3 text-sm bg-bg-surface border border-border-subtle rounded-md text-text-primary focus:outline-none focus:border-accent/50"
        >
          <option value="">{t('routineTemplates.selectPlaceholder')}</option>
          {(variable.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <p className="mt-1 text-[11px] text-text-tertiary">{variable.description}</p>
      </div>
    );
  }

  if (variable.type === 'textarea') {
    return (
      <div>
        {labelNode}
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={variable.placeholder}
          rows={2}
          className="mt-1 w-full px-3 py-2 text-sm bg-bg-surface border border-border-subtle rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 resize-y"
        />
        <p className="mt-1 text-[11px] text-text-tertiary">{variable.description}</p>
      </div>
    );
  }

  return (
    <div>
      {labelNode}
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={variable.placeholder}
        className="mt-1 w-full h-9 px-3 text-sm bg-bg-surface border border-border-subtle rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
      />
      <p className="mt-1 text-[11px] text-text-tertiary">{variable.description}</p>
    </div>
  );
}
