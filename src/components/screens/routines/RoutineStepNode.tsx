import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Shield } from 'lucide-react';
import clsx from 'clsx';
import { ACTION_META } from '../../../utils/step-defaults';
import type { RoutineStepData } from '../../../utils/dag-flow-mapping';

function RoutineStepNode({ data, selected }: NodeProps) {
  const d = data as RoutineStepData;
  const meta = ACTION_META[d.actionType];
  const Icon = meta?.icon;
  const colorHex = meta?.colorHex ?? '#06b6d4';
  const isApprovalGate = d.actionType === 'approval_gate';

  // Truncated preview of params
  const preview = (() => {
    const p = d.params;
    if (d.actionType === 'model_call' || d.actionType === 'expert_step') {
      const prompt = (p.prompt as string) || '';
      return prompt.length > 40 ? prompt.slice(0, 40) + '...' : prompt || 'No prompt set';
    }
    if (d.actionType === 'transformer') {
      return (p.operation as string) || 'format';
    }
    if (d.actionType === 'connector') {
      return (p.service as string) || 'Not configured';
    }
    if (d.actionType === 'channel') {
      return (p.channel as string) || 'Not configured';
    }
    if (isApprovalGate) {
      const summary = (p.summary as string) || '';
      return summary.length > 40 ? summary.slice(0, 40) + '...' : summary || 'Approval checkpoint';
    }
    return '';
  })();

  return (
    <div
      className={clsx(
        'w-[200px] rounded-lg border bg-bg-surface transition-all duration-150',
        selected
          ? isApprovalGate
            ? 'border-amber-400 shadow-[0_0_12px_rgba(245,158,11,0.25)]'
            : 'border-accent shadow-[0_0_12px_rgba(6,182,212,0.25)]'
          : 'border-border-subtle hover:border-border-default',
      )}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-accent !border-bg-surface !w-2 !h-2"
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
          <Shield size={11} className="text-amber-400 ml-auto flex-shrink-0" />
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
        className="!bg-accent !border-bg-surface !w-2 !h-2"
      />
    </div>
  );
}

export default memo(RoutineStepNode);
