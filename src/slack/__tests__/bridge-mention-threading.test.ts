/**
 * SlackBridge app_mention threading — a top-level channel @mention must reply
 * INSIDE the triggering message's thread, not as separate top-level channel
 * messages.
 *
 * Regression test for #52. Slack only delivers `thread_ts` when the mention was
 * already inside a thread, so a fresh top-level mention arrives with
 * `threadTs: undefined`. handleInbound must fall back to the mention's own `ts`
 * as the thread root for channel mentions, so the "thinking…" placeholder and
 * the final answer land under the original message instead of cluttering the
 * channel.
 */
import EventEmitter from 'node:events';
import { describe, expect, it, vi } from 'vitest';

// SlackBridge → secure-token.ts does `import { safeStorage } from 'electron'`, a
// runtime value import. CI installs deps with `npm ci --ignore-scripts`, so the
// electron binary is absent and a real require throws. Mock it
// (encryption-unavailable, the headless fallback the code already handles).
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  app: { getPath: () => '/tmp', getName: () => 'cerebro' },
  ipcMain: { handle: () => undefined, on: () => undefined },
}));

// SlackBridge → claude-code/login-orchestrator does `import * as pty from
// 'node-pty'`, a runtime value import that loads a native binary absent under
// `npm ci --ignore-scripts`. Mock it — this test never spawns a pty.
vi.mock('node-pty', () => ({ spawn: () => undefined }));

import { SlackBridge } from '../bridge';

function makeBridge(api: { chatPostMessage: ReturnType<typeof vi.fn> }) {
  const runtime = {
    startRun: vi.fn(async () => 'run-1'),
    cancelRun: vi.fn(),
  };
  const bridge = new SlackBridge({
    backendPort: 9,
    agentRuntime: runtime as never,
    dataDir: '/tmp',
    engineEventBus: new EventEmitter(),
  });

  // Wire up a live-but-stubbed bridge: real api handle, running, and an
  // allowlist that admits the test channel + user.
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

  // Short-circuit the persistence / routing collaborators that need a backend.
  vi.spyOn(bridge as never, 'buildPromptFromContext').mockResolvedValue(undefined as never);
  vi.spyOn(bridge as never, 'resolveConversation').mockResolvedValue({
    conversationId: 'conv1',
    reused: false,
  } as never);
  vi.spyOn(bridge as never, 'postUserMessageWithRecovery').mockResolvedValue('conv1' as never);
  vi.spyOn(bridge as never, 'emitConversationUpdated').mockImplementation(() => undefined);
  vi.spyOn(bridge as never, 'matchSlackTriggers').mockResolvedValue([] as never);
  vi.spyOn(bridge as never, 'getAccessibleExpertIds').mockReturnValue(null as never);

  return bridge;
}

describe('SlackBridge app_mention threading', () => {
  it('replies to a top-level mention inside the mention thread', async () => {
    const api = {
      chatPostMessage: vi.fn(async (args: { channel: string }) => ({
        ts: '2.000',
        channel: args.channel,
      })),
    };
    const bridge = makeBridge(api);

    await (bridge as unknown as { handleInbound: (ctx: unknown) => Promise<void> }).handleInbound({
      eventId: 'Ev1',
      teamId: 'T1',
      channel: 'C1',
      channelType: 'channel',
      userId: 'U1',
      ts: '123.456',
      threadTs: undefined,
      text: 'hi',
      surface: 'app_mention',
    });
    // Let the sink's placeholder postMessage (fired from the constructor) settle.
    await Promise.resolve();
    await Promise.resolve();

    // The "thinking…" placeholder must be posted in-thread under the mention.
    expect(api.chatPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: '123.456', text: '_Cerebro is thinking…_' }),
    );
  });

  it('keeps an in-thread mention threaded under the original root', async () => {
    const api = {
      chatPostMessage: vi.fn(async (args: { channel: string }) => ({
        ts: '2.000',
        channel: args.channel,
      })),
    };
    const bridge = makeBridge(api);

    await (bridge as unknown as { handleInbound: (ctx: unknown) => Promise<void> }).handleInbound({
      eventId: 'Ev2',
      teamId: 'T1',
      channel: 'C1',
      channelType: 'channel',
      userId: 'U1',
      ts: '200.000',
      threadTs: '100.000',
      text: 'hi again',
      surface: 'app_mention',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(api.chatPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: '100.000', text: '_Cerebro is thinking…_' }),
    );
  });
});
