/**
 * INTEGRATION test for the Slack/Telegram double-post fix.
 *
 * The companion unit test (self-post-guard.test.ts) pins detectSelfPost's logic
 * with a hand-mocked channel. This test closes the seams that unit test mocks
 * away — it wires the REAL SlackBridge / TelegramBridge into a REAL
 * ExecutionEngine and proves the whole collaboration prevents a duplicate send:
 *
 *   real handleInbound → real activeRuns map → real activeConversationOrigin →
 *   engine.runChatAction guard → send is dropped before it reaches Slack.
 *
 * This is the production path: when the model, mid Slack-originated turn, fires
 * send_slack_message back at its OWN channel (the exact bug in the screenshot),
 * the guard must short-circuit so the content posts exactly once (the stream
 * sink already delivered it). A send to a DIFFERENT channel must still proceed.
 */

import EventEmitter from 'node:events';
import { describe, expect, it, vi } from 'vitest';

// SlackBridge/TelegramBridge → secure-token.ts imports `safeStorage` from
// electron (a runtime value). CI installs with --ignore-scripts so the electron
// binary is absent. Mock it (headless, encryption-unavailable fallback).
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  app: { getPath: () => '/tmp', getName: () => 'cerebro' },
  ipcMain: { handle: () => undefined, on: () => undefined },
}));
// SlackBridge → login-orchestrator imports node-pty (native binary). Mock it.
vi.mock('node-pty', () => ({ spawn: () => undefined }));

import { SlackBridge } from '../../slack/bridge';
import { TelegramBridge } from '../../telegram/bridge';
import { ExecutionEngine } from '../engine';

function makeMockWebContents() {
  return { isDestroyed: () => false, send: vi.fn(), ipc: { on: vi.fn() } } as any;
}

/** A live-but-stubbed SlackBridge whose inbound flow resolves to conversation
 *  `conv1` and registers an active run in the real activeRuns map. */
function makeSlackBridge() {
  const api = {
    chatPostMessage: vi.fn(async (args: { channel: string }) => ({
      ts: '2.000',
      channel: args.channel,
    })),
  };
  const bridge = new SlackBridge({
    backendPort: 9,
    agentRuntime: { startRun: vi.fn(async () => 'run-1'), cancelRun: vi.fn() } as never,
    dataDir: '/tmp',
    engineEventBus: new EventEmitter(),
  });
  Object.assign(bridge as unknown as Record<string, unknown>, {
    api,
    running: true,
    settings: {
      allowlistChannels: ['C1'],
      allowlistUsers: ['U1'],
      threadConversationMap: {},
      threadExpertMap: {},
      userDisplayNames: {},
      defaultExpertAccess: null,
      userExpertAccess: {},
      botToken: 'x',
      appToken: 'y',
      enabled: true,
      teamName: null,
      botUserId: 'UBOT',
      operatorUserId: null,
    },
  });
  vi.spyOn(bridge as never, 'buildPromptFromContext').mockResolvedValue(undefined as never);
  vi.spyOn(bridge as never, 'resolveConversation').mockResolvedValue({
    conversationId: 'conv1',
    reused: false,
  } as never);
  vi.spyOn(bridge as never, 'postUserMessageWithRecovery').mockResolvedValue('conv1' as never);
  vi.spyOn(bridge as never, 'emitConversationUpdated').mockImplementation(() => undefined);
  vi.spyOn(bridge as never, 'matchSlackTriggers').mockResolvedValue([] as never);
  vi.spyOn(bridge as never, 'getAccessibleExpertIds').mockReturnValue(null as never);
  return { bridge, api };
}

async function registerSlackRun(bridge: SlackBridge) {
  await (bridge as unknown as { handleInbound: (ctx: unknown) => Promise<void> }).handleInbound({
    eventId: 'Ev1',
    teamId: 'T1',
    channel: 'C1',
    channelType: 'channel',
    userId: 'U1',
    ts: '123.456',
    threadTs: undefined,
    text: 'describe the sales expert',
    surface: 'app_mention',
  });
  // Let the sink's constructor-fired placeholder post settle.
  await Promise.resolve();
  await Promise.resolve();
}

describe('self-post guard — real SlackBridge + ExecutionEngine', () => {
  it('exposes the active conversation origin from the real activeRuns map', async () => {
    const { bridge } = makeSlackBridge();
    await registerSlackRun(bridge);
    // The REAL method reading the REAL map populated by the REAL inbound flow.
    expect(bridge.activeConversationOrigin('conv1')).toEqual({ channel: 'C1' });
    expect(bridge.activeConversationOrigin('other-conv')).toBeNull();
  });

  it('drops a send_slack_message aimed at the conversation’s own channel', async () => {
    const { bridge } = makeSlackBridge();
    await registerSlackRun(bridge);
    const sendSpy = vi.spyOn(bridge, 'sendActionMessage');

    const engine = new ExecutionEngine(1, { startRun: vi.fn() } as never, new EventEmitter());
    engine.setSlackChannel(bridge);

    const result = await engine.runChatAction(makeMockWebContents(), {
      type: 'send_slack_message',
      params: { channel: 'C1', text: 'the same expert description, again' },
      conversationId: 'conv1',
    });

    expect(result.status).toBe('succeeded');
    expect(result.data?.skipped).toBe(true);
    expect(result.data?.reason).toBe('same_destination_as_origin');
    // The decisive assertion: the duplicate never reached Slack.
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('still sends to a DIFFERENT channel (no over-suppression)', async () => {
    const { bridge } = makeSlackBridge();
    await registerSlackRun(bridge);

    const engine = new ExecutionEngine(1, { startRun: vi.fn() } as never, new EventEmitter());
    engine.setSlackChannel(bridge);
    // Different channel → guard must NOT fire; it proceeds to create a run.
    // Stub the run machinery so the pass-through never touches a backend.
    const startRun = vi.spyOn(engine as never, 'startRun').mockResolvedValue('r1' as never);
    vi.spyOn(engine as never, 'hasAutoApprovalRule').mockResolvedValue(true as never);

    void engine.runChatAction(makeMockWebContents(), {
      type: 'send_slack_message',
      params: { channel: 'C2', text: 'a genuinely different post' },
      conversationId: 'conv1',
    });

    // Poll until the action reaches startRun (proves it was not short-circuited).
    const start = Date.now();
    while (startRun.mock.calls.length === 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(startRun).toHaveBeenCalled();
  });
});

/** A live-but-stubbed TelegramBridge with one active run for `tconv` → 12345. */
function makeTelegramBridge() {
  const bridge = new TelegramBridge({
    backendPort: 9,
    agentRuntime: { startRun: vi.fn(async () => 'run-1'), cancelRun: vi.fn() } as never,
    dataDir: '/tmp',
    engineEventBus: new EventEmitter(),
  });
  Object.assign(bridge as unknown as Record<string, unknown>, {
    api: {},
    polling: true,
    settings: { enabled: true, allowlistChats: ['12345'] },
    activeRuns: new Map<number, unknown>([
      [12345, { runId: 'run-1', conversationId: 'tconv', startedAt: 0, lastActivityAt: 0 }],
    ]),
  });
  return bridge;
}

describe('self-post guard — real TelegramBridge + ExecutionEngine', () => {
  it('exposes the active chat id from the real activeRuns map', () => {
    const bridge = makeTelegramBridge();
    expect(bridge.activeConversationChatId('tconv')).toBe(12345);
    expect(bridge.activeConversationChatId('other-conv')).toBeNull();
  });

  it('drops a send_telegram_message aimed at the conversation’s own chat', async () => {
    const bridge = makeTelegramBridge();
    const sendSpy = vi.spyOn(bridge, 'sendActionMessage');

    const engine = new ExecutionEngine(1, { startRun: vi.fn() } as never, new EventEmitter());
    engine.setTelegramChannel(bridge);

    const result = await engine.runChatAction(makeMockWebContents(), {
      type: 'send_telegram_message',
      params: { chat_id: '12345', message: 'the same answer, again' },
      conversationId: 'tconv',
    });

    expect(result.status).toBe('succeeded');
    expect(result.data?.skipped).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
