/**
 * Unit tests for the agent-memory label helpers (issue #66).
 */

import { describe, it, expect } from 'vitest';
import { expertAgentName } from '../../../shared/agent-name';
import { buildSlugLabelMap, matchesQuery, resolveAgentLabel, CEREBRO_LABEL } from './memory-labels';

const EXPERTS = [
  { id: 'expert-ios-001', name: 'Principal iOS Engineer' },
  { id: 'team-build-002', name: 'App Build Team' },
];

describe('resolveAgentLabel', () => {
  const labels = buildSlugLabelMap(EXPERTS);

  it('resolves a known slug to its expert display name', () => {
    const slug = expertAgentName(EXPERTS[0].id, EXPERTS[0].name);
    expect(resolveAgentLabel(slug, labels)).toBe('Principal iOS Engineer');
  });

  it('labels the main agent directory "Cerebro"', () => {
    expect(resolveAgentLabel('cerebro', labels)).toBe(CEREBRO_LABEL);
  });

  it('falls back to a de-kebabbed, hash-stripped label for unknown slugs', () => {
    expect(resolveAgentLabel('legacy-helper-rdww8x', labels)).toBe('Legacy Helper');
  });

  it('returns the raw slug when there is nothing left after stripping', () => {
    expect(resolveAgentLabel('abc123', labels)).toBe('Abc123');
  });
});

describe('matchesQuery', () => {
  it('matches an empty query', () => {
    expect(matchesQuery('Principal iOS Engineer', 'principal-ios-engineer-x', '')).toBe(true);
  });

  it('matches against the friendly label (case-insensitive)', () => {
    expect(matchesQuery('Principal iOS Engineer', 'principal-ios-engineer-x', 'ios')).toBe(true);
  });

  it('matches against the raw slug', () => {
    expect(matchesQuery('Principal iOS Engineer', 'principal-ios-engineer-rdww8x', 'rdww8x')).toBe(
      true,
    );
  });

  it('does not match unrelated text', () => {
    expect(matchesQuery('Principal iOS Engineer', 'principal-ios-engineer-x', 'android')).toBe(
      false,
    );
  });
});
