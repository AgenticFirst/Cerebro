import { describe, it, expect } from 'vitest';
import type { Node } from '@xyflow/react';
import {
  routineTriggerToActionType,
  reconcileTriggerNode,
} from '../hooks/useRoutineCanvas';
import type { Routine, TriggerType } from '../types/routines';

// ── Helpers ────────────────────────────────────────────────────

function makeRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'r-1',
    name: 'Test',
    description: '',
    plainEnglishSteps: null,
    dagJson: null,
    triggerType: 'manual',
    cronExpression: null,
    defaultRunnerId: null,
    isEnabled: true,
    approvalGates: null,
    requiredConnections: null,
    notifyChannels: null,
    source: 'user',
    sourceConversationId: null,
    lastRunAt: null,
    lastRunStatus: null,
    runCount: 0,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

function makeTriggerNode(
  triggerType: string,
  config: Record<string, unknown> = {},
  position: { x: number; y: number } = { x: 0, y: -120 },
): Node {
  return {
    id: '__trigger__',
    type: 'triggerNode',
    position,
    data: { triggerType, config },
    deletable: false,
  };
}

// ── routineTriggerToActionType ────────────────────────────────

describe('routineTriggerToActionType', () => {
  it('maps manual → trigger_manual', () => {
    expect(routineTriggerToActionType('manual')).toBe('trigger_manual');
  });

  it('maps cron → trigger_schedule', () => {
    expect(routineTriggerToActionType('cron')).toBe('trigger_schedule');
  });

  it('maps webhook → trigger_webhook', () => {
    expect(routineTriggerToActionType('webhook')).toBe('trigger_webhook');
  });

  it('falls back to trigger_manual for unknown / empty values', () => {
    expect(routineTriggerToActionType('' as TriggerType)).toBe('trigger_manual');
    expect(routineTriggerToActionType('garbage')).toBe('trigger_manual');
  });
});

// ── reconcileTriggerNode ──────────────────────────────────────

describe('reconcileTriggerNode', () => {
  describe('from null (fresh canvas)', () => {
    it('builds a trigger node for a manual routine', () => {
      const node = reconcileTriggerNode(
        null,
        makeRoutine({ triggerType: 'manual' }),
      );
      expect(node.id).toBe('__trigger__');
      expect(node.type).toBe('triggerNode');
      expect(node.data).toEqual({ triggerType: 'trigger_manual', config: {} });
      expect(node.position).toEqual({ x: 0, y: -120 });
      expect(node.deletable).toBe(false);
    });

    it('builds a webhook trigger with empty config', () => {
      const node = reconcileTriggerNode(
        null,
        makeRoutine({ triggerType: 'webhook' }),
      );
      expect(node.data).toEqual({ triggerType: 'trigger_webhook', config: {} });
    });

    it('builds a cron trigger and seeds cron_expression from the routine', () => {
      const node = reconcileTriggerNode(
        null,
        makeRoutine({ triggerType: 'cron', cronExpression: '0 9 * * 1-5' }),
      );
      expect(node.data).toEqual({
        triggerType: 'trigger_schedule',
        config: { cron_expression: '0 9 * * 1-5' },
      });
    });
  });

  describe('switching trigger type (the original bug)', () => {
    it('manual → webhook updates type and clears config', () => {
      const prev = makeTriggerNode('trigger_manual');
      const node = reconcileTriggerNode(
        prev,
        makeRoutine({ triggerType: 'webhook' }),
      );
      expect(node).not.toBe(prev);
      const data = node.data as { triggerType: string; config: Record<string, unknown> };
      expect(data.triggerType).toBe('trigger_webhook');
      expect(data.config).toEqual({});
    });

    it('manual → cron fills cron_expression from the routine', () => {
      const prev = makeTriggerNode('trigger_manual');
      const node = reconcileTriggerNode(
        prev,
        makeRoutine({ triggerType: 'cron', cronExpression: '30 8 * * 1-5' }),
      );
      const data = node.data as { triggerType: string; config: Record<string, unknown> };
      expect(data.triggerType).toBe('trigger_schedule');
      expect(data.config).toEqual({ cron_expression: '30 8 * * 1-5' });
    });

    it('webhook → manual clears a stale webhook path from config', () => {
      const prev = makeTriggerNode('trigger_webhook', { path: '/webhook/abc' });
      const node = reconcileTriggerNode(
        prev,
        makeRoutine({ triggerType: 'manual' }),
      );
      const data = node.data as { triggerType: string; config: Record<string, unknown> };
      expect(data.triggerType).toBe('trigger_manual');
      expect(data.config).toEqual({});
      expect(data.config).not.toHaveProperty('path');
    });

    it('cron → webhook drops the stale cron_expression', () => {
      const prev = makeTriggerNode('trigger_schedule', {
        cron_expression: '0 9 * * 1-5',
      });
      const node = reconcileTriggerNode(
        prev,
        makeRoutine({ triggerType: 'webhook', cronExpression: null }),
      );
      const data = node.data as { triggerType: string; config: Record<string, unknown> };
      expect(data.triggerType).toBe('trigger_webhook');
      expect(data.config).toEqual({});
      expect(data.config).not.toHaveProperty('cron_expression');
    });
  });

  describe('position is preserved', () => {
    it('keeps a user-dragged position when switching trigger types', () => {
      const prev = makeTriggerNode('trigger_manual', {}, { x: 420, y: 69 });
      const node = reconcileTriggerNode(
        prev,
        makeRoutine({ triggerType: 'webhook' }),
      );
      expect(node.position).toEqual({ x: 420, y: 69 });
    });

    it('defaults to { 0, -120 } when no previous node exists', () => {
      const node = reconcileTriggerNode(
        null,
        makeRoutine({ triggerType: 'cron', cronExpression: '0 9 * * *' }),
      );
      expect(node.position).toEqual({ x: 0, y: -120 });
    });
  });

  describe('idempotency (same-type, same-config)', () => {
    it('returns the same node reference when already in sync (manual)', () => {
      const prev = makeTriggerNode('trigger_manual');
      const node = reconcileTriggerNode(
        prev,
        makeRoutine({ triggerType: 'manual' }),
      );
      expect(node).toBe(prev);
    });

    it('returns the same node reference when already in sync (webhook with path)', () => {
      const prev = makeTriggerNode('trigger_webhook', { path: '/webhook/xyz' });
      const node = reconcileTriggerNode(
        prev,
        makeRoutine({ triggerType: 'webhook' }),
      );
      expect(node).toBe(prev);
    });

    it('returns the same node reference when cron type and cron_expression both match', () => {
      const prev = makeTriggerNode('trigger_schedule', {
        cron_expression: '0 9 * * 1-5',
      });
      const node = reconcileTriggerNode(
        prev,
        makeRoutine({ triggerType: 'cron', cronExpression: '0 9 * * 1-5' }),
      );
      expect(node).toBe(prev);
    });
  });

  describe('same-type config preservation', () => {
    it('preserves user-edited webhook path when the type did not change', () => {
      const prev = makeTriggerNode('trigger_webhook', {
        path: '/webhook/custom',
        secret: 'shh',
      });
      const node = reconcileTriggerNode(
        prev,
        makeRoutine({ triggerType: 'webhook' }),
      );
      // Nothing changed, reference is preserved
      expect(node).toBe(prev);
    });

    it('updates cron_expression in place when routine.cronExpression changes and type stays cron', () => {
      const prev = makeTriggerNode('trigger_schedule', {
        cron_expression: '0 9 * * 1-5',
      });
      const node = reconcileTriggerNode(
        prev,
        makeRoutine({ triggerType: 'cron', cronExpression: '0 10 * * 1-5' }),
      );
      expect(node).not.toBe(prev);
      const data = node.data as { triggerType: string; config: Record<string, unknown> };
      expect(data.triggerType).toBe('trigger_schedule');
      expect(data.config.cron_expression).toBe('0 10 * * 1-5');
    });

    it('does not re-create the node when extra same-type config keys differ in object identity but not value', () => {
      const config = { cron_expression: '0 9 * * 1-5' };
      const prev = makeTriggerNode('trigger_schedule', config);
      const node = reconcileTriggerNode(
        prev,
        makeRoutine({ triggerType: 'cron', cronExpression: '0 9 * * 1-5' }),
      );
      expect(node).toBe(prev);
    });
  });

  describe('unknown / coerced trigger types', () => {
    it('unknown routine.triggerType coerces to trigger_manual', () => {
      const prev = makeTriggerNode('trigger_webhook', { path: '/old' });
      const node = reconcileTriggerNode(
        prev,
        makeRoutine({ triggerType: 'garbage' as TriggerType }),
      );
      const data = node.data as { triggerType: string; config: Record<string, unknown> };
      expect(data.triggerType).toBe('trigger_manual');
      expect(data.config).toEqual({});
    });
  });

  describe('shape of returned node', () => {
    it('always returns a deletable:false triggerNode with id __trigger__', () => {
      const node = reconcileTriggerNode(
        null,
        makeRoutine({ triggerType: 'manual' }),
      );
      expect(node.id).toBe('__trigger__');
      expect(node.type).toBe('triggerNode');
      expect(node.deletable).toBe(false);
    });
  });
});
