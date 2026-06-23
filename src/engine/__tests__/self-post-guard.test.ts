/**
 * Tests for the deterministic self-post (double-post) guard in runChatAction.
 *
 * When a conversation originates from Slack/Telegram, the agent's reply is
 * auto-delivered to that exact channel/chat by the stream sink. If the model
 * ALSO fires a send_* chat-action at that same destination, the identical
 * content posts twice (the bug from the screenshot). buildOriginPreamble asks
 * the model not to; detectSelfPost ENFORCES it by dropping the redundant send
 * before any run is created — reported back as a benign no-op.
 *
 * These cases pin the exact boundary: same destination → suppressed; different
 * destination, no in-flight origin, and non-text sends → pass through to the
 * normal run path. Fully offline — the suppressed path returns before any
 * backend call, and pass-through cases stub startRun + the approval lookup.
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionEngine } from '../engine';

function makeMockWebContents() {
  return {
    isDestroyed: () => false,
    send: vi.fn(),
    ipc: { on: vi.fn(), removeListener: vi.fn() },
  } as any;
}

/** Slack channel whose only in-flight inbound run is conversation `conv1` → C1. */
function makeMockSlackChannel() {
  return {
    isConnected: () => true,
    isAllowlisted: () => true,
    sendActionMessage: vi.fn(async () => ({ messageTs: '1.000', channelId: 'C1', error: null })),
    sendFileActionMessage: vi.fn(async () => ({ fileId: 'F1', error: null })),
    listChannels: vi.fn(async () => ({ ok: true, channels: [], error: undefined })),
    activeConversationOrigin: (conversationId: string) =>
      conversationId === 'conv1' ? { channel: 'C1' } : null,
  } as any;
}

/** Telegram channel whose only in-flight inbound run is conversation `tconv` → 12345. */
function makeMockTelegramChannel() {
  return {
    isConnected: () => true,
    isAllowlisted: () => true,
    sendActionMessage: vi.fn(async () => ({ messageId: 1, error: null })),
    activeConversationChatId: (conversationId: string) =>
      conversationId === 'tconv' ? 12345 : null,
  } as any;
}

function makeEngine() {
  const engine = new ExecutionEngine(1, { startRun: vi.fn() } as any, new EventEmitter());
  engine.setSlackChannel(makeMockSlackChannel());
  engine.setTelegramChannel(makeMockTelegramChannel());
  // Pass-through cases reach startRun; stub it (and the approval lookup it
  // depends on) so they never touch a real backend. The returned promise then
  // waits on the shared bus forever — tests assert startRun was reached rather
  // than awaiting completion.
  const startRun = vi.spyOn(engine as any, 'startRun').mockResolvedValue('run1');
  vi.spyOn(engine as any, 'hasAutoApprovalRule').mockResolvedValue(true);
  return { engine, startRun };
}

const wc = makeMockWebContents();

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('self-post guard (Slack)', () => {
  let engine: ExecutionEngine;
  let startRun: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    ({ engine, startRun } = makeEngine());
  });

  it('suppresses send_slack_message aimed at the conversation origin channel', async () => {
    const result = await engine.runChatAction(wc, {
      type: 'send_slack_message',
      params: { channel: 'C1', text: 'hello' },
      conversationId: 'conv1',
    });
    expect(result.status).toBe('succeeded');
    expect(result.data?.skipped).toBe(true);
    expect(result.data?.sent).toBe(false);
    expect(startRun).not.toHaveBeenCalled();
  });

  it('lets a send to a DIFFERENT channel through', async () => {
    void engine.runChatAction(wc, {
      type: 'send_slack_message',
      params: { channel: 'C2', text: 'hello' },
      conversationId: 'conv1',
    });
    await waitFor(() => startRun.mock.calls.length > 0);
    expect(startRun).toHaveBeenCalled();
  });

  it('does not suppress when the conversation has no in-flight origin run', async () => {
    void engine.runChatAction(wc, {
      type: 'send_slack_message',
      params: { channel: 'C1', text: 'hello' },
      conversationId: 'unknown-conv',
    });
    await waitFor(() => startRun.mock.calls.length > 0);
    expect(startRun).toHaveBeenCalled();
  });

  it('does not suppress when conversationId is absent', async () => {
    void engine.runChatAction(wc, {
      type: 'send_slack_message',
      params: { channel: 'C1', text: 'hello' },
    });
    await waitFor(() => startRun.mock.calls.length > 0);
    expect(startRun).toHaveBeenCalled();
  });

  it('does not guard file uploads to the origin thread', async () => {
    void engine.runChatAction(wc, {
      type: 'send_slack_file',
      params: { channel: 'C1', file_path: '/tmp/x.pdf' },
      conversationId: 'conv1',
    });
    await waitFor(() => startRun.mock.calls.length > 0);
    expect(startRun).toHaveBeenCalled();
  });
});

describe('self-post guard (Telegram)', () => {
  let engine: ExecutionEngine;
  let startRun: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    ({ engine, startRun } = makeEngine());
  });

  it('suppresses send_telegram_message aimed at the conversation origin chat', async () => {
    const result = await engine.runChatAction(wc, {
      type: 'send_telegram_message',
      params: { chat_id: '12345', message: 'hello' },
      conversationId: 'tconv',
    });
    expect(result.status).toBe('succeeded');
    expect(result.data?.skipped).toBe(true);
    expect(startRun).not.toHaveBeenCalled();
  });

  it('lets a send to a DIFFERENT chat through', async () => {
    void engine.runChatAction(wc, {
      type: 'send_telegram_message',
      params: { chat_id: '99999', message: 'hello' },
      conversationId: 'tconv',
    });
    await waitFor(() => startRun.mock.calls.length > 0);
    expect(startRun).toHaveBeenCalled();
  });
});
