/**
 * Action type metadata and default step parameters.
 */

import {
  MessageSquare,
  Bot,
  Shuffle,
  Plug,
  Send,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import type { RoutineStepData } from './dag-flow-mapping';

// ── Action Metadata ───────────────────────────────────────────

export interface ActionMeta {
  name: string;
  icon: LucideIcon;
  color: string;        // Tailwind color class prefix (e.g. 'cyan', 'purple')
  colorHex: string;     // Hex for canvas rendering
  description: string;
}

export const ACTION_META: Record<string, ActionMeta> = {
  model_call: {
    name: 'Model Call',
    icon: MessageSquare,
    color: 'cyan',
    colorHex: '#06b6d4',
    description: 'Single LLM call',
  },
  expert_step: {
    name: 'Expert Step',
    icon: Bot,
    color: 'purple',
    colorHex: '#a855f7',
    description: 'Multi-turn agent',
  },
  transformer: {
    name: 'Transformer',
    icon: Shuffle,
    color: 'amber',
    colorHex: '#f59e0b',
    description: 'Data transform',
  },
  connector: {
    name: 'Connector',
    icon: Plug,
    color: 'blue',
    colorHex: '#3b82f6',
    description: 'External service',
  },
  channel: {
    name: 'Channel',
    icon: Send,
    color: 'green',
    colorHex: '#22c55e',
    description: 'Send message',
  },
  approval_gate: {
    name: 'Approval Gate',
    icon: ShieldCheck,
    color: 'amber',
    colorHex: '#f59e0b',
    description: 'Approval checkpoint',
  },
};

export const ACTION_TYPES = Object.keys(ACTION_META);

// ── Default Step Data ─────────────────────────────────────────

export function getDefaultStepData(
  actionType: string,
): Pick<RoutineStepData, 'params' | 'requiresApproval' | 'onError'> {
  const base = {
    requiresApproval: false,
    onError: 'fail' as const,
  };

  switch (actionType) {
    case 'model_call':
      return { ...base, params: { prompt: '' } };
    case 'expert_step':
      return { ...base, params: { prompt: '' } };
    case 'transformer':
      return { ...base, params: { operation: 'format', template: '' } };
    case 'connector':
      return { ...base, params: { service: '', operation: '' } };
    case 'channel':
      return { ...base, params: { channel: '', operation: 'send', message: '' } };
    case 'approval_gate':
      return { requiresApproval: true, onError: 'fail' as const, params: { summary: '' } };
    default:
      return { ...base, params: {} };
  }
}
