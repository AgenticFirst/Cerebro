import type { Task } from '../../../context/TaskContext';

// Lowercase + strip diacritics so "revision" matches "Revisión" — the app is
// bilingual EN/ES and accented titles are common.
export function normalizeForSearch(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

export function taskMatchesQuery(
  task: Pick<Task, 'title' | 'description_md'>,
  query: string,
): boolean {
  const normalized = normalizeForSearch(query.trim());
  if (!normalized) return true;
  return (
    normalizeForSearch(task.title).includes(normalized) ||
    normalizeForSearch(task.description_md ?? '').includes(normalized)
  );
}
