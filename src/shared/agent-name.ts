/**
 * Pure helpers for computing the on-disk agent name for a Cerebro expert.
 *
 * Safe to import from the renderer — no Node built-ins, no side effects.
 * Must stay in sync with the installer (which writes the actual directories)
 * and with backend sync that fetches these names.
 */

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function hashSuffix(expertId: string): string {
  let h = 0;
  for (let i = 0; i < expertId.length; i++) {
    h = (h * 31 + expertId.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).slice(0, 6).padStart(6, '0');
}

export function expertAgentName(expertId: string, name: string): string {
  const base = slugify(name) || 'expert';
  return `${base}-${hashSuffix(expertId)}`;
}
