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

function makeStubApi(opts: { failPost?: boolean; failUpdate?: boolean } = {}) {
  const posted: PostedMessage[] = [];
  const updated: UpdatedMessage[] = [];
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
  };
  return { api: stub as SlackApi, posted, updated };
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

  it('finalizes with the full text on done', async () => {
    const { api, posted, updated } = makeStubApi();
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
    // We expect the placeholder + at least one chat.update call.
    expect(posted.length).toBeGreaterThanOrEqual(1);
    expect(updated.length).toBeGreaterThanOrEqual(1);
    const lastUpdated = updated[updated.length - 1];
    expect(lastUpdated.text).toContain('Hello, world!');
  });

  it('shows an error message on error event', async () => {
    const { api, updated } = makeStubApi();
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
    const lastUpdated = updated[updated.length - 1];
    expect(lastUpdated?.text).toContain(':warning:');
    expect(lastUpdated?.text).toContain('spawn failed');
  });

  it('still finishes when no placeholder was ever posted', async () => {
    const { api } = makeStubApi({ failPost: true });
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
  });
});
