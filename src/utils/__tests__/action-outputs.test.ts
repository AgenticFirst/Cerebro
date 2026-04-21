import { describe, it, expect } from 'vitest';
import {
  computeAutoWireMapping,
  getAllOutputs,
  getPrimaryOutput,
  sanitizeVarName,
  uniqueVarName,
} from '../action-outputs';

describe('sanitizeVarName', () => {
  it('lowercases and replaces non-alphanumerics with underscores', () => {
    expect(sanitizeVarName('Ask AI about weather')).toBe('ask_ai_about_weather');
  });

  it('collapses runs and trims edges', () => {
    expect(sanitizeVarName('  Summarize!!! Email  ')).toBe('summarize_email');
  });

  it('returns empty string for input with no alphanumerics', () => {
    expect(sanitizeVarName('???')).toBe('');
  });
});

describe('uniqueVarName', () => {
  it('returns base when no collision', () => {
    expect(uniqueVarName('summary', [])).toBe('summary');
  });

  it('falls back to step-id suffix on collision', () => {
    const existing = [
      { sourceStepId: 'abc', sourceField: 'response', targetField: 'summary' },
    ];
    expect(uniqueVarName('summary', existing, 'def-1234-5678')).toBe('summary_def-');
  });

  it('uses numeric suffix when step-id fallback also collides', () => {
    const existing = [
      { sourceStepId: 'a', sourceField: 'r', targetField: 'summary' },
      { sourceStepId: 'b', sourceField: 'r', targetField: 'summary_abcd' },
    ];
    expect(uniqueVarName('summary', existing, 'abcd')).toBe('summary_2');
  });

  it('falls back to step_<id> when base is empty', () => {
    expect(uniqueVarName('', [], 'xyz987')).toBe('step_xyz9');
  });
});

describe('getPrimaryOutput / getAllOutputs', () => {
  it('ask_ai primary is response', () => {
    expect(getPrimaryOutput('ask_ai')).toEqual({
      field: 'response',
      primary: true,
      label: 'AI reply',
    });
  });

  it('classify exposes primary + secondary fields', () => {
    const all = getAllOutputs('classify');
    expect(all.map((o) => o.field)).toEqual(['category', 'confidence', 'reasoning']);
    expect(getPrimaryOutput('classify')?.field).toBe('category');
  });

  it('unknown action types return undefined / empty', () => {
    expect(getPrimaryOutput('send_notification')).toBeUndefined();
    expect(getAllOutputs('send_notification')).toEqual([]);
  });
});

describe('computeAutoWireMapping', () => {
  it('creates a mapping for ask_ai source with no existing mappings', () => {
    const m = computeAutoWireMapping(
      { id: 'step-1', name: 'Summarize email', actionType: 'ask_ai' },
      [],
    );
    expect(m).toEqual({
      sourceStepId: 'step-1',
      sourceField: 'response',
      targetField: 'summarize_email',
    });
  });

  it('returns null when the source has no primary output (terminal action)', () => {
    expect(
      computeAutoWireMapping(
        { id: 'step-1', name: 'Send email', actionType: 'send_notification' },
        [],
      ),
    ).toBeNull();
  });

  it('returns null when a mapping for the same source+field already exists', () => {
    const m = computeAutoWireMapping(
      { id: 'step-1', name: 'Ask AI', actionType: 'ask_ai' },
      [{ sourceStepId: 'step-1', sourceField: 'response', targetField: 'whatever' }],
    );
    expect(m).toBeNull();
  });

  it('disambiguates targetField when two sources sanitize to the same name', () => {
    const m = computeAutoWireMapping(
      { id: 'step-abc1', name: 'Summary', actionType: 'ask_ai' },
      [{ sourceStepId: 'step-xyz9', sourceField: 'response', targetField: 'summary' }],
    );
    expect(m).not.toBeNull();
    expect(m?.targetField).toBe('summary_step');
    expect(m?.sourceField).toBe('response');
  });

  it('falls back to step-id-based target when name is all punctuation', () => {
    const m = computeAutoWireMapping(
      { id: 'abc-1234', name: '???', actionType: 'ask_ai' },
      [],
    );
    expect(m?.targetField).toBe('step_abc-');
  });

  it('resolves classify to its primary field (category)', () => {
    const m = computeAutoWireMapping(
      { id: 'step-1', name: 'Triage', actionType: 'classify' },
      [],
    );
    expect(m).toEqual({
      sourceStepId: 'step-1',
      sourceField: 'category',
      targetField: 'triage',
    });
  });

  it('still produces a mapping when other sources already contributed mappings', () => {
    const existing = [
      { sourceStepId: 'step-A', sourceField: 'category', targetField: 'triage' },
    ];
    const m = computeAutoWireMapping(
      { id: 'step-B', name: 'Summarize', actionType: 'ask_ai' },
      existing,
    );
    expect(m).toEqual({
      sourceStepId: 'step-B',
      sourceField: 'response',
      targetField: 'summarize',
    });
  });
});
