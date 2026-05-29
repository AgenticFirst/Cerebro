/**
 * SlackStreamSink — verify the debounced placeholder/edit pattern and the
 * error path. We stub SlackApi at the method level so the sink talks to a
 * lightweight in-memory recorder.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { SlackStreamSink } from '../SlackStreamSink';
import type { SlackApi } from '../api';

interface PostedMessage { ts: string; text: string; threadTs?: string }
interface UpdatedMessage { ts: string; text: string }
interface DeletedMessage { ts: string; channel: string }

function makeStubApi(opts: {
  failPost?: boolean;
  failUpdate?: boolean;
  failDelete?: boolean | string;
} = {}) {
  const posted: PostedMessage[] = [];
  const updated: UpdatedMessage[] = [];
  const deleted: DeletedMessage[] = [];
  let counter = 0;
  const stub: Partial<SlackApi> = {
    chatPostMessage: vi.fn(async ({ channel, text, thread_ts }: { channel: string; text: string; thread_ts?: string }) => {
      if (opts.failPost) throw new Error('boom');
      counter++;
      const ts = `${counter}.000`;
      posted.push({ ts, text, threadTs: thread_ts });
      return { ts, channel };
    }),
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
  return { api: stub as SlackApi, posted, updated, deleted };
}

describe('SlackStreamSink', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('posts a placeholder on construction', async () => {
    const { api, posted } = makeStubApi();
    let done = false;
    const sink = new SlackStreamSink({
      api,
      channel: 'C1',
      threadTs: '1.000',
      onDone: () => { done = true; },
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
      onDone: (text) => { finalText = text; },
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

  it('posts an error event as a new notifying message and deletes the placeholder', async () => {
    const { api, posted, deleted } = makeStubApi();
    let errSeen: string | undefined;
    const sink = new SlackStreamSink({
      api,
      channel: 'C1',
      threadTs: '1.000',
      onDone: (_t, err) => { errSeen = err; },
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
      onDone: (t) => { finalText = t; },
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
      onDone: (t) => { finalText = t; },
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
      onDone: (t) => { finalText = t; },
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
});
