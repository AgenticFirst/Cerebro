export const TEXT_EXTENSIONS = new Set([
  'md', 'txt', 'json', 'yaml', 'yml', 'toml', 'xml', 'csv',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp',
  'css', 'scss', 'sass', 'less',
  'sh', 'bash', 'zsh', 'fish',
  'env', 'gitignore', 'dockerfile', 'log',
]);

export const HTML_EXTENSIONS = new Set(['html', 'htm']);
export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'avif']);
export const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov']);
export const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg']);
export const PDF_EXTENSIONS = new Set(['pdf']);

export function previewKindFor(ext: string): 'markdown' | 'html' | 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'binary' {
  const e = ext.toLowerCase();
  if (e === 'md') return 'markdown';
  if (HTML_EXTENSIONS.has(e)) return 'html';
  if (IMAGE_EXTENSIONS.has(e)) return 'image';
  if (VIDEO_EXTENSIONS.has(e)) return 'video';
  if (AUDIO_EXTENSIONS.has(e)) return 'audio';
  if (PDF_EXTENSIONS.has(e)) return 'pdf';
  if (TEXT_EXTENSIONS.has(e) || e === '') return 'text';
  return 'binary';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function formatRelative(iso: string | null): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
