import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Shield } from 'lucide-react';
import clsx from 'clsx';
import { ACTION_META, CATEGORY_MAP, resolveActionType } from '../../../utils/step-defaults';
import { getHandleType, HANDLE_COLORS } from '../../../utils/handle-types';
import type { RoutineStepData } from '../../../utils/dag-flow-mapping';
import Tooltip, { TooltipCard } from '../../ui/Tooltip';

/** Background tint per category (Tailwind-compatible). */
const CATEGORY_BG: Record<string, string> = {
  ai: 'bg-violet-500/5',
  knowledge: 'bg-indigo-500/5',
  integrations: 'bg-blue-500/5',
  logic: 'bg-slate-400/5',
  output: 'bg-emerald-500/5',
};

function RoutineStepNode({ data, selected }: NodeProps) {
  const { t } = useTranslation();
  const d = data as RoutineStepData;
  const resolved = resolveActionType(d.actionType);
  const meta = ACTION_META[resolved] ?? ACTION_META[d.actionType];
  const Icon = meta?.icon;
  const colorHex = meta?.colorHex ?? '#06b6d4';
  const category = meta?.category;
  const categoryMeta = category ? CATEGORY_MAP[category] : null;
  const categoryColor = categoryMeta?.colorHex ?? colorHex;

  // Handle colors based on output type
  const handleType = getHandleType(resolved);
  const handleColor = HANDLE_COLORS[handleType];

  // Truncated preview of params
  const preview = (() => {
    const p = d.params;

    // AI actions
    if (resolved === 'ask_ai') {
      const prompt = (p.prompt as string) || '';
      return prompt.length > 40 ? prompt.slice(0, 40) + '...' : prompt || t('routineEditor.noPromptSet');
    }
    if (resolved === 'run_expert') {
      const task = (p.task as string) || (p.prompt as string) || '';
      return task.length > 40 ? task.slice(0, 40) + '...' : task || t('routineEditor.noTaskSet');
    }
    if (resolved === 'classify') {
      const cats = p.categories;
      if (Array.isArray(cats) && cats.length > 0) return `${cats.length} categories`;
      return t('routineEditor.noCategoriesDefined');
    }
    if (resolved === 'extract') {
      const schema = p.schema;
      if (Array.isArray(schema) && schema.length > 0) return `${schema.length} fields`;
      return t('routineEditor.noSchemaDefined');
    }
    if (resolved === 'summarize') {
      return (p.max_length as string) || 'medium';
    }

    // Knowledge actions
    if (resolved === 'search_memory' || resolved === 'search_web') {
      const q = (p.query as string) || '';
      return q.length > 40 ? q.slice(0, 40) + '...' : q || t('routineEditor.noQuerySet');
    }
    if (resolved === 'save_to_memory') {
      return (p.scope as string) || 'global';
    }

    // Integrations
    if (resolved === 'http_request') {
      const method = (p.method as string) || 'GET';
      const url = (p.url as string) || '';
      return url ? `${method} ${url.slice(0, 30)}` : t('triggers.notConfigured');
    }
    if (resolved === 'run_command') {
      const cmd = (p.command as string) || '';
      const args = (p.args as string) || '';
      const full = args ? `${cmd} ${args}` : cmd;
      return full.length > 40 ? full.slice(0, 37) + '...' : full || t('routineEditor.noCommandSet');
    }
    if (resolved === 'run_claude_code') {
      const mode = (p.mode as string) || 'ask';
      return mode.charAt(0).toUpperCase() + mode.slice(1);
    }

    // Logic
    if (resolved === 'wait_for_webhook') {
      return (p.match_path as string) || t('routineEditor.waitingForWebhook');
    }
    if (resolved === 'run_script') {
      const lang = (p.language as string) || 'python';
      const code = (p.code as string) || '';
      const firstLine = code.split('\n')[0] || '';
      return `${lang}: ${firstLine}`.slice(0, 40) || lang;
    }
    if (resolved === 'condition') {
      const field = (p.field as string) || '';
      const op = (p.operator as string) || '';
      const val = (p.value as string) || '';
      return field ? `${field} ${op} ${val}`.trim().slice(0, 40) : t('triggers.notConfigured');
    }
    if (resolved === 'loop') {
      return (p.items_field as string) || t('routineEditor.noItemsField');
    }
    if (resolved === 'delay') {
      const dur = p.duration ?? '';
      const unit = (p.unit as string) || 'seconds';
      return dur ? `${dur} ${unit}` : t('triggers.notConfigured');
    }
    if (resolved === 'approval_gate') {
      const summary = (p.summary as string) || '';
      return summary.length > 40 ? summary.slice(0, 40) + '...' : summary || t('routineEditor.approvalCheckpoint');
    }

    // Output
    if (resolved === 'send_message') {
      const msg = (p.message as string) || '';
      return msg.length > 40 ? msg.slice(0, 40) + '...' : msg || t('routineEditor.noMessageSet');
    }
    if (resolved === 'send_notification') {
      return (p.title as string) || t('routineEditor.noTitleSet');
    }

    // Legacy fallbacks
    if (d.actionType === 'transformer') {
      return (p.operation as string) || 'format';
    }
    if (d.actionType === 'connector') {
      return (p.service as string) || t('triggers.notConfigured');
    }
    if (d.actionType === 'channel') {
      return (p.channel as string) || t('triggers.notConfigured');
    }

    return '';
  })();

  const hoverCard = useMemo(() => {
    const rows: Array<{ label: string; value: string }> = [];
    if (meta?.description) rows.push({ label: t('routineTooltips.metaAction'), value: meta.description });
    if (preview) rows.push({ label: t('routineTooltips.metaConfig'), value: preview });
    if (d.requiresApproval) rows.push({ label: t('routineTooltips.metaGate'), value: t('routineTooltips.approvalRequired') });
    if (d.onError) rows.push({ label: t('routineTooltips.metaOnError'), value: String(d.onError) });
    return (
      <TooltipCard
        title={d.name || meta?.name || d.actionType}
        description={meta?.name ?? d.actionType}
        meta={rows}
        hint={t('routineTooltips.stepNodeHint')}
      />
    );
  }, [d.name, d.actionType, d.requiresApproval, d.onError, meta, preview, t]);

  return (
    <Tooltip label={hoverCard} size="md" side="right" delay={500}>
      <div
        className={clsx(
          'w-[200px] rounded-lg border transition-all duration-150',
          CATEGORY_BG[category ?? ''] || 'bg-bg-surface',
          selected
            ? 'shadow-lg'
            : 'hover:border-border-default',
          !selected && 'border-border-subtle',
        )}
        style={{
          borderLeftWidth: 4,
          borderLeftColor: categoryColor,
          // Use longhand border-{side}-color instead of the `borderColor`
          // shorthand so React doesn't warn about mixing shorthand with
          // `borderLeftColor` when selection toggles.
          ...(selected
            ? {
                borderTopColor: categoryColor,
                borderRightColor: categoryColor,
                borderBottomColor: categoryColor,
                boxShadow: `0 0 12px ${categoryColor}40`,
              }
            : {}),
        }}
      >
        <Handle
          type="target"
          position={Position.Top}
          className="!border-bg-surface !w-2 !h-2"
          style={{ backgroundColor: handleColor }}
          title={t('routineTooltips.nodeHandleTarget')}
        />

        {/* Top row: icon + type label */}
        <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
          {Icon && (
            <div
              className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: `${colorHex}20` }}
            >
              <Icon size={12} style={{ color: colorHex }} />
            </div>
          )}
          <span
            className="text-[10px] font-medium uppercase tracking-wider"
            style={{ color: colorHex }}
          >
            {meta?.name ?? d.actionType}
          </span>
          {d.requiresApproval && (
            <span className="ml-auto flex-shrink-0">
              <Shield size={11} className="text-amber-400" />
            </span>
          )}
        </div>

        {/* Step name */}
        <div className="px-3 pb-1">
          <span className="text-sm font-medium text-text-primary truncate block">
            {d.name}
          </span>
        </div>

        {/* Preview */}
        <div className="px-3 pb-2.5">
          <span className="text-[11px] text-text-tertiary truncate block">
            {preview}
          </span>
        </div>

        <Handle
          type="source"
          position={Position.Bottom}
          className="!border-bg-surface !w-2 !h-2"
          style={{ backgroundColor: handleColor }}
          title={t('routineTooltips.nodeHandleSource')}
        />
      </div>
    </Tooltip>
  );
}

export default memo(RoutineStepNode);
