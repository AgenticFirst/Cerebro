import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MediaIngestService, _internal } from '../media-ingest';

/**
 * In-process mock backend for MediaIngestService. Lets the test exercise the
 * real http.request path without standing up the FastAPI server.
 */
class MockBackend {
  server: http.Server;
  port = 0;
  fromPathCalls: any[] = [];
  parseCalls: any[] = [];
  sttCalls: any[] = [];
  parseFails = false;
  sttResponse: { text: string; language?: string } | null = { text: 'hola mundo', language: 'es' };
  parseResponse: any = null;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const payload = body ? JSON.parse(body) : {};
        if (req.url === '/files/items/from-path') {
          this.fromPathCalls.push(payload);
          const stat = fs.statSync(payload.file_path);
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            id: 'fid_' + Math.random().toString(36).slice(2, 8),
            name: path.basename(payload.file_path),
            ext: path.extname(payload.file_path).replace(/^\./, ''),
            mime: 'application/octet-stream',
            size_bytes: stat.size,
            sha256: 'fakehash' + stat.size,
            storage_path: payload.file_path,
          }));
          return;
        }
        if (req.url === '/files/parse') {
          this.parseCalls.push(payload);
          if (this.parseFails) {
            res.writeHead(422); res.end('parse failed'); return;
          }
          const parsedPath = this.parseResponse?.parsed_path
            ?? path.join(os.tmpdir(), `parsed-${Date.now()}.md`);
          fs.writeFileSync(parsedPath, '# parsed\n\ncontent');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            sha256: 'fakehash',
            parsed_path: parsedPath,
            char_count: 20,
            parser: 'python-docx',
            parser_version: '1.2.0',
            truncated: this.parseResponse?.truncated ?? false,
            warning: this.parseResponse?.warning ?? null,
            cached: false,
          }));
          return;
        }
        if (req.url === '/voice/stt/transcribe-file') {
          this.sttCalls.push(payload);
          if (!this.sttResponse) {
            res.writeHead(500); res.end('boom'); return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(this.sttResponse));
          return;
        }
        res.writeHead(404); res.end();
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', () => resolve()));
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

let mock: MockBackend;
let tmpDir: string;
let svc: MediaIngestService;

beforeEach(async () => {
  mock = new MockBackend();
  await mock.start();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebro-ingest-'));
  svc = new MediaIngestService({
    getBackendPort: () => mock.port,
    transcriptDir: path.join(tmpDir, '_transcripts'),
  });
});

afterEach(async () => {
  await mock.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(name: string, bytes: Buffer | string = 'hello'): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

describe('categoryForExt', () => {
  it('classifies known extensions', () => {
    expect(MediaIngestService.categoryForExt('docx')).toBe('office');
    expect(MediaIngestService.categoryForExt('XLSX')).toBe('office');
    expect(MediaIngestService.categoryForExt('pdf')).toBe('pdf');
    expect(MediaIngestService.categoryForExt('png')).toBe('image');
    expect(MediaIngestService.categoryForExt('mp3')).toBe('audio');
    expect(MediaIngestService.categoryForExt('mp4')).toBe('video');
    expect(MediaIngestService.categoryForExt('md')).toBe('text');
    expect(MediaIngestService.categoryForExt('xyz')).toBe('unknown');
  });
});

describe('ingest', () => {
  it('parses .docx and rewrites injection to the markdown sidecar', async () => {
    const docx = writeFile('estructura.docx', Buffer.from('PKfake'));
    const out = await svc.ingest({ filePath: docx, source: 'chat-upload' });

    expect(out.error).toBeUndefined();
    expect(out.category).toBe('office');
    expect(out.parsedTextPath).toBeDefined();
    expect(out.parsedTextPath!.endsWith('.md')).toBe(true);
    expect(out.promptInjection.startsWith('@')).toBe(true);
    expect(out.promptInjection).toContain('.md');
    expect(out.promptInjection).toContain('parsed from estructura.docx');

    expect(mock.fromPathCalls).toHaveLength(1);
    expect(mock.fromPathCalls[0].source).toBe('chat-upload');
    expect(mock.parseCalls).toHaveLength(1);
  });

  it('parses .pdf', async () => {
    const pdf = writeFile('doc.pdf', Buffer.from('%PDF-1.4'));
    const out = await svc.ingest({ filePath: pdf, source: 'chat-upload' });
    expect(out.category).toBe('pdf');
    expect(out.parsedTextPath).toBeDefined();
  });

  it('handles parse failure with a non-binary fallback injection', async () => {
    mock.parseFails = true;
    const docx = writeFile('bad.docx', Buffer.from('PKbroken'));
    const out = await svc.ingest({ filePath: docx, source: 'chat-upload' });
    expect(out.error).toContain('could not parse');
    // Crucially the injection must NOT use the @-prefix on the binary path —
    // that's exactly what crashes Claude Code's Read tool.
    expect(out.promptInjection).not.toContain('@' + docx);
    expect(out.promptInjection).toContain('do not try to Read this binary');
  });

  it('passthroughs images', async () => {
    const png = writeFile('photo.png');
    const out = await svc.ingest({ filePath: png, source: 'chat-upload' });
    expect(out.category).toBe('image');
    expect(out.parsedTextPath).toBeUndefined();
    expect(out.promptInjection).toBe('@' + png);
    expect(mock.parseCalls).toHaveLength(0);
  });

  it('passthroughs text files', async () => {
    const md = writeFile('note.md', '# notes');
    const out = await svc.ingest({ filePath: md, source: 'chat-upload' });
    expect(out.category).toBe('text');
    expect(out.promptInjection).toBe('@' + md);
  });

  it('inlines short audio transcripts as <voice_note>', async () => {
    const audio = writeFile('voice.ogg');
    const out = await svc.ingest({ filePath: audio, source: 'telegram-inbound' });
    expect(out.category).toBe('audio');
    expect(out.inlineText).toBe('hola mundo');
    expect(out.promptInjection).toContain('<voice_note');
    expect(out.promptInjection).toContain('hola mundo');
  });

  it('writes long audio transcripts to a sidecar', async () => {
    mock.sttResponse = { text: 'palabra '.repeat(500), language: 'es' };
    const audio = writeFile('voice.ogg');
    const out = await svc.ingest({ filePath: audio, source: 'telegram-inbound' });
    expect(out.parsedTextPath).toBeDefined();
    expect(out.parsedTextPath!.endsWith('.transcript.md')).toBe(true);
    expect(fs.readFileSync(out.parsedTextPath!, 'utf8')).toContain('palabra');
  });

  it('handles STT failure with a clear marker', async () => {
    mock.sttResponse = null;
    const audio = writeFile('voice.ogg');
    const out = await svc.ingest({ filePath: audio, source: 'telegram-inbound' });
    expect(out.error).toBe('transcription failed');
    expect(out.promptInjection).toContain('transcription unavailable');
  });

  it('marks video as unprocessed without trying to Read it', async () => {
    const vid = writeFile('clip.mp4');
    const out = await svc.ingest({ filePath: vid, source: 'whatsapp-inbound' });
    expect(out.category).toBe('video');
    expect(out.warning).toContain('not processed');
    expect(out.promptInjection).toContain('cannot view video');
  });

  it('marks unknown types so the model does not try to Read garbage', async () => {
    const bin = writeFile('weird.bin');
    const out = await svc.ingest({ filePath: bin, source: 'chat-upload' });
    expect(out.category).toBe('unknown');
    expect(out.promptInjection).toContain('unsupported type');
  });

  it('returns an error attachment when the file is missing', async () => {
    const out = await svc.ingest({ filePath: '/no/such/file.docx', source: 'chat-upload' });
    expect(out.error).toBe('file not found on disk');
    expect(out.promptInjection).toContain('could not be processed');
  });
});

describe('resolveContent', () => {
  it('rewrites every existing @path; ignores @-tokens that are not real files', async () => {
    const docx = writeFile('plantilla.docx', Buffer.from('PK'));
    const png = writeFile('foto.png');
    const content = `@${docx}\n\nMira esta imagen @${png} y este placeholder @relative-thing y @/no/such/path.docx`;
    const out = await svc.resolveContent(content, 'chat-upload');

    expect(out.attachments).toHaveLength(2);
    // .docx token replaced by parsed-path injection
    expect(out.content).not.toContain(`@${docx}`);
    expect(out.content).toContain('.md');
    expect(out.content).toContain('parsed from plantilla.docx');
    // image token preserved as @path
    expect(out.content).toContain(`@${png}`);
    // unrelated @-tokens left untouched
    expect(out.content).toContain('@relative-thing');
    expect(out.content).toContain('@/no/such/path.docx');
  });

  it('returns content unchanged when there are no @ paths', async () => {
    const out = await svc.resolveContent('hola que tal', 'chat-upload');
    expect(out.content).toBe('hola que tal');
    expect(out.attachments).toHaveLength(0);
  });
});

describe('extractAtPaths', () => {
  it('only returns tokens that exist on disk', () => {
    const real = writeFile('real.txt');
    const tokens = _internal.extractAtPaths(`@${real} and @/nope`);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toBe(real);
  });
});

describe('regression: .docx no longer reaches claude -p as binary', () => {
  // Mirrors the original bug: user attached `Estructura-Documento-….docx`
  // to a chat, ChatInput prepended `@/abs/path/file.docx` to the prompt,
  // runtime piped that string into `claude -p`, Claude Code's Read tool
  // hit binary bytes and the subprocess exited 1.
  // After resolveContent, the prompt that would reach `claude -p` must
  // reference a UTF-8 markdown sidecar — never the raw .docx.
  it('rewrites the user-attached .docx to a parsed markdown sidecar', async () => {
    const docx = writeFile(
      'Estructura-Documento-Manuales.docx',
      Buffer.from('PKfake-zip-bytes'),
    );
    const userMessage = `@${docx}\n\nnecesito que el experto en crear manuales utilice siempre este documento como guia, tome en cuenta los titulos, subtitulos, estructura, fondos, cabecera, pie de pagina, etc y que siempre que me entregue manuales sea en ese formato.`;

    const out = await svc.resolveContent(userMessage, 'chat-upload');
    // The prompt that claude -p would receive...
    const promptToClaude = out.content;

    // ...must NOT contain the original `@/path/file.docx` reference,
    // because Claude Code's Read tool can't parse binary docx and crashes.
    expect(promptToClaude).not.toContain(`@${docx}`);
    // ...and must contain a `@<sha>.md` reference instead.
    expect(promptToClaude).toMatch(/@.+\.md/);
    expect(promptToClaude).toContain('parsed from Estructura-Documento-Manuales.docx');
    // The user's actual message text must survive intact.
    expect(promptToClaude).toContain('experto en crear manuales');
    expect(promptToClaude).toContain('titulos, subtitulos, estructura');
  });
});
