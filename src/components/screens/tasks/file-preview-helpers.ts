import type { WorkspaceFileNode } from '../../../types/ipc';

export type PreviewKind = 'static' | 'dev_server' | 'video' | 'image' | 'pdf' | 'audio' | 'text';

const VIDEO_EXTS = ['.mp4', '.webm', '.mov'];
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif'];
const AUDIO_EXTS = ['.mp3', '.wav', '.ogg'];
const PDF_EXTS = ['.pdf'];

const TEXT_EXTS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.md',
  '.mdx',
  '.txt',
  '.log',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cc',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.html',
  '.htm',
  '.xml',
  '.css',
  '.scss',
  '.less',
  '.env',
  '.env.example',
  '.gitignore',
  '.dockerignore',
  '.dockerfile',
  '.editorconfig',
];

export function hasTextExt(name: string): boolean {
  const lower = name.toLowerCase();
  if (TEXT_EXTS.some((e) => lower.endsWith(e))) return true;
  if (['dockerfile', 'makefile', 'readme', 'license', 'procfile'].includes(lower)) return true;
  return false;
}

export function kindForFile(name: string): PreviewKind | null {
  const lower = name.toLowerCase();
  if (lower === 'index.html') return 'static';
  if (VIDEO_EXTS.some((e) => lower.endsWith(e))) return 'video';
  if (IMAGE_EXTS.some((e) => lower.endsWith(e))) return 'image';
  if (PDF_EXTS.some((e) => lower.endsWith(e))) return 'pdf';
  if (AUDIO_EXTS.some((e) => lower.endsWith(e))) return 'audio';
  if (hasTextExt(name)) return 'text';
  return null;
}

/** Stable fingerprint over a workspace tree — used to skip React state writes
 * when a poll returns identical data, so the file browser doesn't re-render
 * (and lose scroll/selection) on every tick. */
export function treeFingerprint(tree: WorkspaceFileNode[]): string {
  const out: string[] = [];
  const walk = (nodes: WorkspaceFileNode[]) => {
    for (const n of nodes) {
      out.push(`${n.path}:${n.size ?? 0}:${n.mtime ?? 0}`);
      if (n.children) walk(n.children);
    }
  };
  walk(tree);
  return out.join('|');
}
