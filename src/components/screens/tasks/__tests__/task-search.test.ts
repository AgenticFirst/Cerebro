import { describe, it, expect } from 'vitest';
import { normalizeForSearch, taskMatchesQuery } from '../task-search';

describe('normalizeForSearch', () => {
  it('lowercases and strips diacritics', () => {
    expect(normalizeForSearch('Revisión Título')).toBe('revision titulo');
  });
});

describe('taskMatchesQuery', () => {
  const task = {
    title: 'Fix login flow',
    description_md: 'La página de **revisión** se rompe al enviar',
  };

  it('matches on title', () => {
    expect(taskMatchesQuery(task, 'login')).toBe(true);
  });

  it('matches on description', () => {
    expect(taskMatchesQuery(task, 'rompe')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(taskMatchesQuery(task, 'FIX LOGIN')).toBe(true);
  });

  it('is accent-insensitive in both directions', () => {
    expect(taskMatchesQuery(task, 'revision')).toBe(true);
    expect(taskMatchesQuery(task, 'página')).toBe(true);
    expect(taskMatchesQuery({ title: 'Sin acentos', description_md: '' }, 'sín acentós')).toBe(
      true,
    );
  });

  it('returns false when nothing matches', () => {
    expect(taskMatchesQuery(task, 'deploy')).toBe(false);
  });

  it('matches everything on empty or whitespace-only query', () => {
    expect(taskMatchesQuery(task, '')).toBe(true);
    expect(taskMatchesQuery(task, '   ')).toBe(true);
  });

  it('tolerates missing description', () => {
    expect(
      taskMatchesQuery({ title: 'Solo título', description_md: undefined as unknown as string }, 'algo'),
    ).toBe(false);
  });
});
