/**
 * SlackStreamSink — verify the debounced placeholder/edit pattern and the
 * error path. We stub SlackApi at the method level so the sink talks to a
 * lightweight in-memory recorder.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SlackStreamSink } from '../SlackStreamSink';
import type { SlackApi } from '../api';

interface PostedMessage {
  ts: string;
  text: string;
  threadTs?: string;
}
interface UpdatedMessage {
  ts: string;
  text: string;
}
interface DeletedMessage {
  ts: string;
  channel: string;
}
interface UploadedFile {
  channelId: string;
  filePath: string;
  threadTs?: string;
  fileName?: string;
}

function makeStubApi(
  opts: {
    failPost?: boolean;
    failUpdate?: boolean;
    failDelete?: boolean | string;
    failUpload?: boolean;
  } = {},
) {
  const posted: PostedMessage[] = [];
  const updated: UpdatedMessage[] = [];
  const deleted: DeletedMessage[] = [];
  const uploaded: UploadedFile[] = [];
  let counter = 0;
  const stub: Partial<SlackApi> = {
    filesUpload: vi.fn(
      async ({
        channelId,
        filePath,
        threadTs,
        fileName,
      }: {
        channelId: string;
        filePath: string;
        threadTs?: string;
        fileName?: string;
      }) => {
        if (opts.failUpload) throw new Error('upload boom');
        uploaded.push({ channelId, filePath, threadTs, fileName });
        return { fileId: `F${uploaded.length}` };
      },
    ),
    chatPostMessage: vi.fn(
      async ({
        channel,
        text,
        thread_ts,
      }: {
        channel: string;
        text: string;
        thread_ts?: string;
      }) => {
        if (opts.failPost) throw new Error('boom');
        counter++;
        const ts = `${counter}.000`;
        posted.push({ ts, text, threadTs: thread_ts });
        return { ts, channel };
      },
    ),
    chatUpdate: vi.fn(async ({ ts, text }: { ts: string; text: string }) => {
      if (opts.failUpdate) throw new Error('boom');
      updated.push({ ts, text });
      return { ts, channel: 'C1' };
    }),
    chatDelete: vi.fn(async ({ channel, ts }: { channel: string; ts: string }) => {
      if (opts.failDelete) {
        throw new Error(typeof opts.failDelete === 'string' ? opts.failDelete : 'ratelimited');
      }
      deleted.push({ ts, channel });
    }),
  };
  return { api: stub as SlackApi, posted, updated, deleted, uploaded };
}

describe('SlackStreamSink', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts a placeholder on construction', async () => {
    const { api, posted } = makeStubApi();
    let done = false;
    const sink = new SlackStreamSink({
      api,
      channel: 'C1',
      threadTs: '1.000',
      onDone: () => {
        done = true;
      },
    });
    // Allow the microtask that fires the placeholder send to resolve.
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(posted.length).toBe(1);
    expect(posted[0].threadTs).toBe('1.000');
    sink.send('engine:any-event', { type: 'done', runId: 'r1', messageContent: '' });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it('finalizes with the full text as a new posted message on done', async () => {
    const { api, posted, updated, deleted } = makeStubApi();
    let finalText = '';
    const sink = new SlackStreamSink({
      api,
      channel: 'C1',
      threadTs: '1.000',
      onDone: (text) => {
        finalText = text;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    sink.send('engine:any-event', { type: 'text_delta', delta: 'Hello' });
    sink.send('engine:any-event', { type: 'text_delta', delta: ', world!' });
    // Advance past the debounce so the scheduled edit fires.
    await vi.advanceTimersByTimeAsync(2_000);
    sink.send('engine:any-event', { type: 'done', runId: 'r1', messageContent: 'Hello, world!' });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    expect(finalText).toBe('Hello, world!');
    // Slack does not push notifications for edits, so the final answer must
    // arrive as a fresh chat.postMessage (which rings the user's client) and
    // the streaming placeholder must be deleted afterwards.
    expect(posted.length).toBe(2);
    expect(posted[0].text).toMatch(/thinking/i);
    expect(posted[posted.length - 1].text).toBe('Hello, world!');
    expect(posted[posted.length - 1].threadTs).toBe('1.000');
    expect(deleted.length).toBe(1);
    expect(deleted[0].ts).toBe(posted[0].ts);
    // Streaming edits during the debounce window are fine — the bug we
    // fixed is that the FINAL delivery was a silent edit. Now it's a post.
    void updated;
  });

  it('posts the final answer exactly once when two done events arrive', async () => {
    // Regression: the runner used to emit the completion on two channels
    // ('event' with type done + the dedicated 'done'), and finalize() only
    // set `destroyed` AFTER its awaited Slack calls — so the second done
    // slipped past the guard and the full answer was posted twice.
    const { api, posted } = makeStubApi();
    let doneCalls = 0;
    const sink = new SlackStreamSink({
      api,
      channel: 'C1',
      threadTs: '1.000',
      onDone: () => {
        doneCalls++;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    sink.send('engine:any-event', { type: 'done', runId: 'r1', messageContent: 'the answer' });
    sink.send('engine:any-event', { type: 'done', runId: 'r1', messageContent: 'the answer' });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    const finals = posted.filter((m) => m.text === 'the answer');
    expect(finals.length).toBe(1);
    expect(doneCalls).toBe(1);
  });

  it('posts an error event as a new notifying message and deletes the placeholder', async () => {
    const { api, posted, deleted } = makeStubApi();
    let errSeen: string | undefined;
    const sink = new SlackStreamSink({
      api,
      channel: 'C1',
      threadTs: '1.000',
      onDone: (_t, err) => {
        errSeen = err;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    sink.send('engine:any-event', { type: 'error', runId: 'r1', error: 'spawn failed' });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    expect(errSeen).toBe('spawn failed');
    const lastPosted = posted[posted.length - 1];
    expect(lastPosted?.text).toContain(':warning:');
    expect(lastPosted?.text).toContain('spawn failed');
    expect(deleted.length).toBe(1);
  });

  it('still finishes when no placeholder was ever posted', async () => {
    const { api, deleted } = makeStubApi({ failPost: true });
    let finalText: string | undefined;
    const sink = new SlackStreamSink({
      api,
      channel: 'C1',
      threadTs: '1.000',
      onDone: (t) => {
        finalText = t;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    sink.send('engine:any-event', { type: 'done', runId: 'r1', messageContent: 'reply' });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    expect(finalText).toBe('reply');
    // Nothing to delete — placeholder send never produced a ts.
    expect(deleted.length).toBe(0);
  });

  it('still delivers the final answer even when chat.delete fails', async () => {
    const { api, posted, deleted } = makeStubApi({ failDelete: 'ratelimited' });
    let finalText = '';
    const sink = new SlackStreamSink({
      api,
      channel: 'C1',
      threadTs: '1.000',
      onDone: (t) => {
        finalText = t;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    sink.send('engine:any-event', { type: 'done', runId: 'r1', messageContent: 'final answer' });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    expect(finalText).toBe('final answer');
    // An orphaned placeholder above the final answer is OK; a missing
    // notification is not. Assert the answer was still posted fresh.
    expect(deleted.length).toBe(0);
    expect(posted[posted.length - 1].text).toBe('final answer');
  });

  it('posts at top level when threadTs is undefined (no thread_ts on the wire)', async () => {
    const { api, posted } = makeStubApi();
    const sink = new SlackStreamSink({
      api,
      channel: 'C1',
      threadTs: undefined,
      onDone: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(posted.length).toBe(1);
    expect(posted[0].threadTs).toBeUndefined();

    sink.send('engine:any-event', { type: 'text_delta', delta: 'one ' });
    sink.send('engine:any-event', { type: 'text_delta', delta: 'two three '.repeat(500) });
    sink.send('engine:any-event', { type: 'done', runId: 'r1', messageContent: 'a'.repeat(7000) });
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();
    // Every follow-up overflow post also goes top-level.
    for (const p of posted) {
      expect(p.threadTs).toBeUndefined();
    }
  });

  it('renders CommonMark as Slack mrkdwn in the final posted message', async () => {
    const { api, posted } = makeStubApi();
    let finalText = '';
    const sink = new SlackStreamSink({
      api,
      channel: 'C1',
      threadTs: '1.000',
      onDone: (t) => {
        finalText = t;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    const md = '## Hola\n**negrita** y [enlace](https://x.test)';
    sink.send('engine:any-event', { type: 'done', runId: 'r1', messageContent: md });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    // onDone keeps the original CommonMark for the conversation log.
    expect(finalText).toBe(md);
    const last = posted[posted.length - 1];
    expect(last.text).toBe('*Hola*\n*negrita* y <https://x.test|enlace>');
  });

  describe('file delivery (trailing @/path)', () => {
    let tmpDir: string;
    let realFile: string;

    beforeEach(() => {
      // Real timers are restored per-test by the outer afterEach; mkdtemp is fine
      // under fake timers since it doesn't schedule anything.
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebro-sink-'));
      realFile = path.join(tmpDir, 'cerebro-logo.png');
      fs.writeFileSync(realFile, 'png-bytes');
    });
    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('uploads a trailing @/path file and strips the path from the posted text', async () => {
      const { api, posted, uploaded } = makeStubApi();
      const sink = new SlackStreamSink({
        api,
        channel: 'C1',
        threadTs: '1.000',
        onDone: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(0);
      const reply = `Aquí tienes el logo de Cerebro (316 KB, PNG):\n\n@${realFile}`;
      sink.send('engine:any-event', { type: 'done', runId: 'r1', messageContent: reply });
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      // The real file was uploaded into the same channel/thread.
      expect(uploaded.length).toBe(1);
      expect(uploaded[0]).toMatchObject({
        channelId: 'C1',
        filePath: realFile,
        threadTs: '1.000',
        fileName: 'cerebro-logo.png',
      });
      // The prose was posted, but the raw @/path line is gone from it.
      const last = posted[posted.length - 1];
      expect(last.text).toContain('Aquí tienes el logo de Cerebro');
      expect(last.text).not.toContain('@/');
      expect(last.text).not.toContain(realFile);
    });

    it('uploads with no text post when the reply is only the file path', async () => {
      const { api, posted, uploaded } = makeStubApi();
      const sink = new SlackStreamSink({
        api,
        channel: 'C1',
        threadTs: '1.000',
        onDone: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(0);
      sink.send('engine:any-event', {
        type: 'done',
        runId: 'r1',
        messageContent: `@${realFile}`,
      });
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      expect(uploaded.length).toBe(1);
      // Only the placeholder was ever posted — no empty/"(empty response)" body.
      expect(posted.length).toBe(1);
      expect(posted[0].text).toMatch(/thinking/i);
    });

    it('keeps a non-existent @/path as text and does not upload', async () => {
      const { api, posted, uploaded } = makeStubApi();
      const sink = new SlackStreamSink({
        api,
        channel: 'C1',
        threadTs: '1.000',
        onDone: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(0);
      const missing = path.join(tmpDir, 'nope.png');
      const reply = `Here you go:\n\n@${missing}`;
      sink.send('engine:any-event', { type: 'done', runId: 'r1', messageContent: reply });
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      expect(uploaded.length).toBe(0);
      const last = posted[posted.length - 1];
      expect(last.text).toContain('Here you go');
      expect(last.text).toContain(`@${missing}`);
    });

    it('falls back to posting the path as text when the upload fails', async () => {
      const { api, posted, uploaded } = makeStubApi({ failUpload: true });
      const sink = new SlackStreamSink({
        api,
        channel: 'C1',
        threadTs: '1.000',
        onDone: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(0);
      sink.send('engine:any-event', {
        type: 'done',
        runId: 'r1',
        messageContent: `Logo:\n\n@${realFile}`,
      });
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      expect(uploaded.length).toBe(0);
      // The prose posted, then a fallback message carrying the path.
      const texts = posted.map((p) => p.text);
      expect(texts.some((t) => t.includes('Logo'))).toBe(true);
      expect(texts.some((t) => t.includes(`@${realFile}`))).toBe(true);
    });

    it('does not upload anything for a plain prose reply', async () => {
      const { api, uploaded } = makeStubApi();
      const sink = new SlackStreamSink({
        api,
        channel: 'C1',
        threadTs: '1.000',
        onDone: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(0);
      sink.send('engine:any-event', {
        type: 'done',
        runId: 'r1',
        messageContent: 'Just a normal answer.',
      });
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
      expect(uploaded.length).toBe(0);
    });

    it('uploads multiple files in order with a single prose post', async () => {
      const second = path.join(tmpDir, 'report.pdf');
      fs.writeFileSync(second, 'pdf-bytes');
      const { api, posted, uploaded } = makeStubApi();
      const sink = new SlackStreamSink({
        api,
        channel: 'C1',
        threadTs: '1.000',
        onDone: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(0);
      const reply = `Aquí tienes ambos:\n@${realFile}\n@${second}`;
      sink.send('engine:any-event', { type: 'done', runId: 'r1', messageContent: reply });
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      expect(uploaded.map((u) => u.filePath)).toEqual([realFile, second]);
      // Exactly one final prose post (placeholder + one body), not one per file.
      const bodyPosts = posted.filter((p) => !/thinking/i.test(p.text));
      expect(bodyPosts.length).toBe(1);
      expect(bodyPosts[0].text).toContain('Aquí tienes ambos');
      expect(bodyPosts[0].text).not.toContain('@/');
    });

    it('uploads at top level (no thread_ts) for a DM reply', async () => {
      const { api, uploaded } = makeStubApi();
      const sink = new SlackStreamSink({
        api,
        channel: 'D1',
        threadTs: undefined,
        onDone: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(0);
      sink.send('engine:any-event', { type: 'done', runId: 'r1', messageContent: `@${realFile}` });
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
      expect(uploaded.length).toBe(1);
      expect(uploaded[0].channelId).toBe('D1');
      expect(uploaded[0].threadTs).toBeUndefined();
    });

    it('uploads the real file but keeps a missing one as text (mixed)', async () => {
      const missing = path.join(tmpDir, 'gone.pdf');
      const { api, posted, uploaded } = makeStubApi();
      const sink = new SlackStreamSink({
        api,
        channel: 'C1',
        threadTs: '1.000',
        onDone: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(0);
      const reply = `Files:\n@${realFile}\n@${missing}`;
      sink.send('engine:any-event', { type: 'done', runId: 'r1', messageContent: reply });
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      // Only the existing file uploaded.
      expect(uploaded.map((u) => u.filePath)).toEqual([realFile]);
      // The missing path survives in the posted text; the uploaded one does not.
      const body = posted
        .filter((p) => !/thinking/i.test(p.text))
        .map((p) => p.text)
        .join('\n');
      expect(body).toContain(`@${missing}`);
      expect(body).not.toContain(realFile);
    });

    it('uploads a path containing spaces', async () => {
      const spaced = path.join(tmpDir, 'Informe Final Q3.docx');
      fs.writeFileSync(spaced, 'docx-bytes');
      const { api, uploaded } = makeStubApi();
      const sink = new SlackStreamSink({
        api,
        channel: 'C1',
        threadTs: '1.000',
        onDone: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(0);
      sink.send('engine:any-event', {
        type: 'done',
        runId: 'r1',
        messageContent: `Listo:\n@${spaced}`,
      });
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
      expect(uploaded.length).toBe(1);
      expect(uploaded[0].filePath).toBe(spaced);
      expect(uploaded[0].fileName).toBe('Informe Final Q3.docx');
    });

    it('keeps the literal @/path in the conversation log via onDone', async () => {
      const { api } = makeStubApi();
      let logged = '';
      const reply = `Aquí está el logo:\n\n@${realFile}`;
      const sink = new SlackStreamSink({
        api,
        channel: 'C1',
        threadTs: '1.000',
        onDone: (t) => {
          logged = t;
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      sink.send('engine:any-event', { type: 'done', runId: 'r1', messageContent: reply });
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
      // onDone records the agent's full message (incl. the path line) so the
      // conversation memory matches what the model actually said.
      expect(logged).toBe(reply);
    });
  });
});
