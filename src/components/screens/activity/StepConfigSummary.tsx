import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useExperts } from '../../../context/ExpertContext';
import type { StepRecord } from './types';
import JsonSection from './JsonSection';

interface StepConfigSummaryProps {
  step: StepRecord;
  /**
   * Serialized DAG from `run.dag_json`. The configured `params` for each
   * step live on the DAG, not on the step record — `step.input_json` only
   * holds the upstream wired-input values resolved at runtime, which is
   * empty for queued/early-failed steps. Pass the DAG and we look up
   * `step.params` by `step_id`.
   */
  dagJson?: string | null;
}

interface DAGStepLite {
  id: string;
  params?: Record<string, unknown>;
}

interface KV {
  label: string;
  value: string;
  emphasis?: boolean;
}

/**
 * Action-specific, human-readable rendering of the step's configured
 * params (from the DAG). The user sees "Expert: Customer Support
 * Specialist" instead of a raw JSON dump. Falls back to a collapsible
 * JsonSection for action types we haven't specialized yet.
 */
export default function StepConfigSummary({ step, dagJson }: StepConfigSummaryProps) {
  const { t } = useTranslation();
  const { experts } = useExperts();

  // Configured params from the DAG. This is the source of truth for what
  // the user set in the editor (expertId, prompt, model, subject, etc.).
  const configuredParams = useMemo<Record<string, unknown>>(() => {
    if (!dagJson) return {};
    try {
      const dag = JSON.parse(dagJson) as { steps?: DAGStepLite[] };
      const dagStep = dag.steps?.find((s) => s.id === step.step_id);
      return (dagStep?.params ?? {}) as Record<string, unknown>;
    } catch {
      return {};
    }
  }, [dagJson, step.step_id]);

  // Resolved wired-input values from the engine (only populated once the
  // step starts executing). Used as a fallback when the DAG isn't passed.
  const wiredParams = useMemo<Record<string, unknown>>(() => {
    if (!step.input_json) return {};
    try {
      const parsed = JSON.parse(step.input_json);
      return (parsed?.params ?? parsed ?? {}) as Record<string, unknown>;
    } catch {
      return {};
    }
  }, [step.input_json]);

  // Configured params win; wired params fill in any gaps for steps where
  // the engine resolved more than what was statically configured.
  const params = useMemo(
    () => ({ ...wiredParams, ...configuredParams }),
    [wiredParams, configuredParams],
  );

  const rows = useMemo<KV[]>(() => buildRows(step.action_type, params, experts, t), [step.action_type, params, experts, t]);

  if (rows.length === 0) {
    return <JsonSection label={t('stepConfig.rawInput')} json={step.input_json} />;
  }

  return (
    <div className="rounded-md border border-border-subtle bg-bg-base/40 px-2.5 py-2 space-y-1">
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline gap-2 text-[11px]">
          <span className="text-text-tertiary uppercase tracking-wide text-[9px] w-[72px] flex-shrink-0">
            {row.label}
          </span>
          <span className={row.emphasis ? 'text-text-primary font-medium' : 'text-text-secondary'}>
            {row.value || '—'}
          </span>
        </div>
      ))}
    </div>
  );
}

function buildRows(
  actionType: string,
  params: Record<string, unknown>,
  experts: { id: string; name: string }[],
  t: (key: string, opts?: Record<string, unknown>) => string,
): KV[] {
  const get = (key: string): string => {
    const v = params[key];
    return typeof v === 'string' ? v : v == null ? '' : String(v);
  };
  const trunc = (s: string, max = 100): string => (s.length > max ? s.slice(0, max - 1) + '…' : s);

  switch (actionType) {
    case 'run_expert':
    case 'expert_step': {
      const expertId = get('expertId');
      const expert = experts.find((e) => e.id === expertId);
      return [
        {
          label: t('stepConfig.expert'),
          value: expert?.name ?? (expertId ? expertId : t('stepConfig.globalCerebro')),
          emphasis: true,
        },
        { label: t('stepConfig.model'), value: get('model') || t('stepConfig.modelDefault') },
        { label: t('stepConfig.prompt'), value: trunc(get('prompt')) },
        { label: t('stepConfig.maxTurns'), value: String(params.maxTurns ?? '—') },
      ];
    }
    case 'ask_ai':
    case 'model_call':
      return [
        { label: t('stepConfig.model'), value: get('model') || t('stepConfig.modelDefault'), emphasis: true },
        { label: t('stepConfig.agent'), value: get('agent') || 'cerebro' },
        { label: t('stepConfig.prompt'), value: trunc(get('prompt')) },
      ];
    case 'hubspot_create_ticket':
      return [
        { label: t('stepConfig.subject'), value: get('subject'), emphasis: true },
        { label: t('stepConfig.priority'), value: get('priority') || t('stepConfig.notSet') },
        { label: t('stepConfig.pipeline'), value: get('pipeline') || t('stepConfig.useDefaults') },
        { label: t('stepConfig.stage'), value: get('stage') || t('stepConfig.useDefaults') },
        { label: t('stepConfig.contact'), value: get('contact_id') || '—' },
      ];
    case 'hubspot_upsert_contact':
      return [
        { label: t('stepConfig.email'), value: get('email'), emphasis: true },
        { label: t('stepConfig.phone'), value: get('phone') },
        { label: t('stepConfig.firstName'), value: get('firstname') },
        { label: t('stepConfig.lastName'), value: get('lastname') },
      ];
    case 'http_request':
    case 'connector':
      return [
        { label: t('stepConfig.method'), value: get('method') || 'GET', emphasis: true },
        { label: t('stepConfig.url'), value: trunc(get('url')) },
        { label: t('stepConfig.auth'), value: get('auth_type') || 'none' },
      ];
    case 'send_message':
    case 'channel':
      return [
        { label: t('stepConfig.target'), value: get('target') || 'cerebro_chat', emphasis: true },
        { label: t('stepConfig.message'), value: trunc(get('message')) },
      ];
    case 'send_notification':
      return [
        { label: t('stepConfig.title'), value: get('title'), emphasis: true },
        { label: t('stepConfig.body'), value: trunc(get('body')) },
        { label: t('stepConfig.urgency'), value: get('urgency') || 'normal' },
      ];
    case 'send_telegram_message':
      return [
        { label: t('stepConfig.chatId'), value: get('chat_id'), emphasis: true },
        { label: t('stepConfig.message'), value: trunc(get('message')) },
      ];
    case 'send_whatsapp_message':
      return [
        { label: t('stepConfig.phone'), value: get('phone_number'), emphasis: true },
        { label: t('stepConfig.message'), value: trunc(get('message')) },
      ];
    default:
      return [];
  }
}
