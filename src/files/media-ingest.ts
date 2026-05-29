/**
 * MediaIngestService — single point of entry for "host has a file on disk,
 * model needs to consume it safely".
 *
 * Hashes the file, registers a FileItem row via /files/items/from-path,
 * dispatches to the parsing layer (office/PDF), STT (audio), or passthrough
 * (image/text), and returns a ResolvedAttachment whose `promptInjection`
 * field is what the chat send path / integration bridges paste into the
 * prompt. Nothing else touches Claude Code with a `.docx` reference.
 *
 * All processing is bounded by p-limit(3) so a five-file drag-drop doesn't
 * pin the CPU or the STT engine.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

import type {
  IngestRequest,
  IngestSource,
  MediaCategory,
  ResolvedAttachment,
} from './types';

const OFFICE_EXTS = new Set(['docx', 'xlsx', 'xlsm', 'pptx']);
const PDF_EXTS = new Set(['pdf']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const AUDIO_EXTS = new Set(['mp3', 'm4a', 'wav', 'ogg', 'opus', 'flac', 'aac', 'webm']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv']);
const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'yaml', 'yml', 'log']);

/** Inline transcripts shorter than this go straight into the prompt; longer
 * ones are written to a sidecar so prompt size stays predictable. */
const INLINE_TRANSCRIPT_CHAR_CAP = 2000;

/** Crude bounded fan-out — we don't want the whole `p-limit` package for one use. */
function withConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });
  return Promise.all(workers).then(() => results);
}

interface ParseResponse {
  sha256: string;
  parsed_path: string;
  char_count: number;
  parser: string;
  parser_version: string;
  truncated: boolean;
  warning: string | null;
  cached: boolean;
}

interface FromPathResponse {
  id: string;
  name: string;
  ext: string;
  mime: string | null;
  size_bytes: number;
  sha256: string | null;
  storage_path: string;
}

interface STTResponse {
  text: string;
  language?: string;
}

export interface MediaIngestServiceOptions {
  getBackendPort: () => number | null;
  /** Optional override for the parsed-text sidecar root. The backend writes
   * sidecars under <files-dir>/_parsed; we only need to know this path if
   * we want to dedupe long transcripts to disk. */
  transcriptDir?: string;
}

export class MediaIngestService {
  constructor(private readonly opts: MediaIngestServiceOptions) {}

  static categoryForExt(ext: string): MediaCategory {
    const e = ext.toLowerCase().replace(/^\./, '');
    if (OFFICE_EXTS.has(e)) return 'office';
    if (PDF_EXTS.has(e)) return 'pdf';
    if (IMAGE_EXTS.has(e)) return 'image';
    if (AUDIO_EXTS.has(e)) return 'audio';
    if (VIDEO_EXTS.has(e)) return 'video';
    if (TEXT_EXTS.has(e)) return 'text';
    return 'unknown';
  }

  /** Resolve a single attachment. Errors do not throw — they surface on `.error`. */
  async ingest(req: IngestRequest): Promise<ResolvedAttachment> {
    const port = this.opts.getBackendPort();
    if (!port) return errorAttachment(req.filePath, 'backend not ready');

    if (!fs.existsSync(req.filePath)) {
      return errorAttachment(req.filePath, 'file not found on disk');
    }

    const originalName = path.basename(req.filePath);
    const ext = path.extname(originalName).toLowerCase().replace(/^\./, '');
    const category = MediaIngestService.categoryForExt(ext);

    // Register the FileItem (workspace pointer — no copy). The backend hashes
    // and sniffs MIME via magic bytes for us.
    const item = await fromPath(port, req);
    if (!item) return errorAttachment(req.filePath, 'failed to register file item');

    const base: ResolvedAttachment = {
      fileItemId: item.id,
      originalPath: item.storage_path,
      originalName,
      mime: item.mime,
      sizeBytes: item.size_bytes,
      sha256: item.sha256 ?? '',
      category,
      promptInjection: `@${item.storage_path}`,
    };

    if (category === 'office' || category === 'pdf') {
      const parsed = await parseFile(port, item.storage_path, item.sha256 ?? undefined);
      if (!parsed) {
        return {
          ...base,
          error: `could not parse .${ext}`,
          promptInjection: this.fallbackInjection(originalName, item.storage_path, ext),
        };
      }
      return {
        ...base,
        parsedTextPath: parsed.parsed_path,
        truncated: parsed.truncated,
        warning: parsed.warning ?? undefined,
        promptInjection: `@${parsed.parsed_path}\n[parsed from ${originalName}${parsed.truncated ? ' — truncated' : ''}]`,
      };
    }

    if (category === 'audio') {
      const stt = await transcribe(port, item.storage_path);
      if (!stt) {
        return {
          ...base,
          error: 'transcription failed',
          promptInjection: `[audio attached at ${item.storage_path} — transcription unavailable]`,
        };
      }
      const transcript = stt.text.trim();
      if (transcript.length === 0) {
        return {
          ...base,
          inlineText: '',
          promptInjection: `[audio attached at ${item.storage_path} — silent or unintelligible]`,
        };
      }
      if (transcript.length <= INLINE_TRANSCRIPT_CHAR_CAP) {
        return {
          ...base,
          inlineText: transcript,
          promptInjection:
            `<voice_note from="${originalName}"${stt.language ? ` lang="${stt.language}"` : ''}>\n${transcript}\n</voice_note>`,
        };
      }
      // Long transcript → write to sidecar so the prompt stays bounded.
      const sidecar = this.writeTranscriptSidecar(item.sha256 ?? originalName, transcript);
      return {
        ...base,
        inlineText: transcript.slice(0, INLINE_TRANSCRIPT_CHAR_CAP) + '…',
        parsedTextPath: sidecar ?? undefined,
        promptInjection: sidecar
          ? `@${sidecar}\n[transcribed from voice note ${originalName}]`
          : `<voice_note from="${originalName}">\n${transcript.slice(0, INLINE_TRANSCRIPT_CHAR_CAP)}…\n</voice_note>`,
      };
    }

    if (category === 'image' || category === 'text') {
      // Passthrough: Claude Code's Read tool handles both natively.
      return base;
    }

    if (category === 'video') {
      // No video processing today — just announce it so the model knows.
      return {
        ...base,
        warning: 'video attachments are not processed (no extraction yet)',
        promptInjection: `[video attached at ${item.storage_path} — Cerebro cannot view video frames; ask the user to summarize]`,
      };
    }

    // unknown category — leave the @path so the user can see what was passed.
    return {
      ...base,
      warning: `unrecognized file type: .${ext || 'unknown'}`,
      promptInjection: `[file attached at ${item.storage_path} — unsupported type ".${ext}"]`,
    };
  }

  /** Resolve many attachments concurrently, capped at 3. */
  ingestMany(reqs: IngestRequest[]): Promise<ResolvedAttachment[]> {
    return withConcurrency(reqs, 3, (r) => this.ingest(r));
  }

  /**
   * Scan free-form chat content for `@<absolute-path>` references that point
   * to files Cerebro should pre-process. Returns the rewritten content plus
   * the resolved attachments, in order, so callers can persist UI metadata.
   *
   * Lines that don't match an existing absolute path are left untouched —
   * Claude Code has its own `@` semantics for project-relative refs.
   */
  async resolveContent(
    content: string,
    source: IngestSource,
    conversationId?: string | null,
  ): Promise<{ content: string; attachments: ResolvedAttachment[] }> {
    const tokens = extractAtPaths(content);
    if (tokens.length === 0) return { content, attachments: [] };

    const resolved = await this.ingestMany(
      tokens.map((t) => ({
        filePath: t.path,
        source,
        conversationId: conversationId ?? null,
      })),
    );

    // Replace every original @path token with its prompt injection.
    let rewritten = content;
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const att = resolved[i];
      // Only replace once per token — duplicate paths are rare and the second
      // occurrence in a single message would be the user's choice.
      const idx = rewritten.indexOf(tok.raw);
      if (idx === -1) continue;
      rewritten =
        rewritten.slice(0, idx) +
        att.promptInjection +
        rewritten.slice(idx + tok.raw.length);
    }
    return { content: rewritten, attachments: resolved };
  }

  private fallbackInjection(name: string, abs: string, ext: string): string {
    return `[file attached: ${name} (.${ext}) at ${abs} — could not extract text on host; do not try to Read this binary]`;
  }

  private writeTranscriptSidecar(key: string, text: string): string | null {
    const dir = this.opts.transcriptDir;
    if (!dir) return null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const safeKey = key.replace(/[^a-z0-9]/gi, '_').slice(0, 64);
      const out = path.join(dir, `${safeKey}.transcript.md`);
      fs.writeFileSync(out, text, 'utf8');
      return out;
    } catch {
      return null;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Helpers

function errorAttachment(filePath: string, error: string): ResolvedAttachment {
  return {
    fileItemId: '',
    originalPath: filePath,
    originalName: path.basename(filePath),
    mime: null,
    sizeBytes: 0,
    sha256: '',
    category: 'unknown',
    error,
    promptInjection: `[attachment ${path.basename(filePath)} could not be processed: ${error}]`,
  };
}

interface AtPathToken {
  raw: string;       // exact slice including the leading "@"
  path: string;      // absolute path on disk
}

/** Find @<absolute-path> tokens in free text. Stops at whitespace or newline.
 * Only returns tokens whose path actually exists on disk — anything else is
 * Claude Code's own @-syntax (relative refs, agent names, etc.). */
function extractAtPaths(content: string): AtPathToken[] {
  const tokens: AtPathToken[] = [];
  // Match @ followed by an absolute-looking path. Allow most filename chars
  // including spaces if quoted via `@"..."` (we generate plain @path today
  // but keep the door open). Stop at newline or unescaped whitespace.
  const re = /@(\/[^\s\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const candidate = m[1];
    if (!fs.existsSync(candidate)) continue;
    if (!fs.statSync(candidate).isFile()) continue;
    tokens.push({ raw: m[0], path: candidate });
  }
  return tokens;
}

function fromPath(port: number, req: IngestRequest): Promise<FromPathResponse | null> {
  return backendPost<FromPathResponse>(port, '/files/items/from-path', {
    file_path: req.filePath,
    source: req.source,
    source_conversation_id: req.conversationId ?? null,
    source_message_id: req.messageId ?? null,
  });
}

function parseFile(port: number, filePath: string, sha256?: string): Promise<ParseResponse | null> {
  return backendPost<ParseResponse>(port, '/files/parse', {
    file_path: filePath,
    sha256: sha256 || null,
  });
}

function transcribe(port: number, filePath: string): Promise<STTResponse | null> {
  return backendPost<STTResponse>(port, '/voice/stt/transcribe-file', {
    file_path: filePath,
  });
}

function backendPost<T>(port: number, urlPath: string, body: unknown): Promise<T | null> {
  return new Promise((resolve) => {
    const bodyStr = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr).toString(),
        },
        timeout: 30_000,   // STT can take a few seconds for long voice notes
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => {
          if (!res.statusCode || res.statusCode >= 400) {
            resolve(null);
            return;
          }
          try { resolve(JSON.parse(data) as T); }
          catch { resolve(null); }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(bodyStr);
    req.end();
  });
}

// Exported for tests.
export const _internal = { extractAtPaths };
