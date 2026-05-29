export const EXT_LABELS: Record<string, string> = {
  ts: 'TS', tsx: 'TX', js: 'JS', jsx: 'JX',
  py: 'PY', rs: 'RS', go: 'GO', rb: 'RB',
  json: '{}', md: 'MD', txt: 'TXT', html: '<>',
  css: 'CS', yaml: 'YM', yml: 'YM', toml: 'TM',
  sh: 'SH', sql: 'SQ', pdf: 'PF', swift: 'SW',
  java: 'JA', c: 'C', cpp: 'C+', h: 'H',
};

export function labelForExt(ext: string): string {
  return EXT_LABELS[ext] || ext.slice(0, 2).toUpperCase() || '?';
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
