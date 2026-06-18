/**
 * SlackBridge voice-note ingestion — regression for "No detecta notas de voz
 * desde Slack" (native Slack audio clips were silently dropped).
 *
 * Root cause: a native clip is AAC-in-MP4 (`mimetype: audio/mp4`, `filetype:
 * mp4`, file `subtype: slack_audio`). The old detection keyed off the file
 * extension category, and `mp4` classifies as VIDEO — so the clip was never
 * recognized as audio, never downloaded, never transcribed, and (having no
 * caption) was dropped by the empty-text guard. No error surfaced either.
 *
 * These tests drive the REAL `buildPromptFromContext` + `handleInbound` (only
 * the backend-touching collaborators are stubbed) so they prove the whole path:
 *   detect audio → download as .m4a (NOT .mp4) → STT → transcript becomes the
 *   message → agent run starts with that transcript.
 */
import EventEmitter from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same headless mocks the other bridge tests use: electron's safeStorage and
// node-pty load native binaries absent under `npm ci --ignore-scripts`.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  app: { getPath: () => '/tmp', getName: () => 'cerebro' },
  ipcMain: { handle: () => undefined, on: () => undefined },
}));
vi.mock('node-pty', () => ({ spawn: () => undefined }));

import { SlackBridge } from '../bridge';
import type { SlackFile } from '../types';

/** A native Slack voice clip as Slack actually delivers it. */
const NATIVE_VOICE_CLIP: SlackFile = {
  id: 'F_VOICE',
  name: 'audio_message.mp4', // ext "mp4" — the trap
  mimetype: 'audio/mp4',
  filetype: 'mp4',
  subtype: 'slack_audio',
  url_private_download: 'https://files.slack.com/audio_message.mp4',
  size: 12_345,
};

interface Stubs {
  downloadFile: ReturnType<typeof vi.fn>;
  ingest: ReturnType<typeof vi.fn>;
  startRun: ReturnType<typeof vi.fn>;
  chatPostMessage: ReturnType<typeof vi.fn>;
}

function makeBridge(transcript: string | ''): { bridge: SlackBridge; stubs: Stubs } {
  const startRun = vi.fn(async () => 'run-1');
  const runtime = { startRun, cancelRun: vi.fn() };
  const chatPostMessage = vi.fn(async (args: { channel: string }) => ({
    ts: '2.000',
    channel: args.channel,
  }));
  const downloadFile = vi.fn(async () => undefined);
  // mediaIngest.ingest resolves with the STT result. inlineText '' models a
  // silent/garbled clip; a non-empty string models a successful transcription.
  const ingest = vi.fn(async () => ({ inlineText: transcript }));

  const bridge = new SlackBridge({
    backendPort: 9,
    agentRuntime: runtime as never,
    dataDir: '/tmp',
    engineEventBus: new EventEmitter(),
  });

  Object.assign(bridge as unknown as Record<string, unknown>, {
    api: { downloadFile, chatPostMessage, chatPostEphemeral: vi.fn(async () => undefined) },
    mediaIngest: { ingest },
    running: true,
    settings: {
      allowlistChannels: ['*'],
      allowlistUsers: ['*'],
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

  // Avoid the real staging dir + STT model load + backend persistence.
  vi.spyOn(bridge as never, 'tempDir').mockReturnValue('/tmp/slack-staging' as never);
  vi.spyOn(bridge as never, 'ensureSTTReady').mockResolvedValue(true as never);
  vi.spyOn(bridge as never, 'resolveConversation').mockResolvedValue({
    conversationId: 'conv1',
    reused: false,
  } as never);
  vi.spyOn(bridge as never, 'postUserMessageWithRecovery').mockResolvedValue('conv1' as never);
  vi.spyOn(bridge as never, 'emitConversationUpdated').mockImplementation(() => undefined);
  vi.spyOn(bridge as never, 'matchSlackTriggers').mockResolvedValue([] as never);
  vi.spyOn(bridge as never, 'getAccessibleExpertIds').mockReturnValue(null as never);

  return { bridge, stubs: { downloadFile, ingest, startRun, chatPostMessage } };
}

function dmVoiceCtx(text = '', files: SlackFile[] = [NATIVE_VOICE_CLIP]) {
  return {
    eventId: 'Ev_voice',
    teamId: 'T1',
    channel: 'D1',
    channelType: 'im' as const,
    userId: 'U1',
    ts: '123.456',
    threadTs: undefined,
    text,
    files,
    surface: 'message_im' as const,
  };
}

type Internals = {
  handleInbound: (ctx: ReturnType<typeof dmVoiceCtx>) => Promise<void>;
  buildPromptFromContext: (
    ctx: { text: string; files?: SlackFile[] } & Record<string, unknown>,
  ) => Promise<void>;
};

beforeEach(() => {
  // Swallow the 30-min staging-cleanup setTimeout that downloadSlackFile arms.
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SlackBridge — native voice note end-to-end', () => {
  it('transcribes a captionless audio/mp4 clip and starts the run with the transcript', async () => {
    const transcript = 'hola, esto es una nota de voz';
    const { bridge, stubs } = makeBridge(transcript);

    await (bridge as unknown as Internals).handleInbound(dmVoiceCtx(''));

    // 1. Detected as audio and downloaded — the old code returned before this.
    expect(stubs.downloadFile).toHaveBeenCalledTimes(1);
    // 2. THE regression: saved with an STT-friendly extension, never the
    //    video-classed .mp4. This is what routes ingest to Whisper.
    const destArg = stubs.downloadFile.mock.calls[0][1] as string;
    expect(destArg).toMatch(/\.m4a$/);
    expect(destArg).not.toMatch(/\.mp4$/);
    // 3. Ingest (STT) ran against that .m4a file.
    expect(stubs.ingest).toHaveBeenCalledTimes(1);
    expect((stubs.ingest.mock.calls[0][0] as { filePath: string }).filePath).toMatch(/\.m4a$/);
    // 4. The transcript reached the agent run as the message content — proving
    //    the empty-text guard no longer drops a voice-only message.
    expect(stubs.startRun).toHaveBeenCalledTimes(1);
    const runRequest = stubs.startRun.mock.calls[0][1] as { content: string };
    expect(runRequest.content).toBe(transcript);
  });

  it('appends a typed caption to the transcript', async () => {
    const { bridge, stubs } = makeBridge('transcribed words');
    await (bridge as unknown as Internals).handleInbound(dmVoiceCtx('please action this'));

    const runRequest = stubs.startRun.mock.calls[0][1] as { content: string };
    expect(runRequest.content).toBe('transcribed words\n\nplease action this');
  });

  it('does NOT start a run for a silent/garbled clip with no caption', async () => {
    // ingest returns empty inlineText → nothing transcribable. The user gets a
    // nudge note, and we never launch the agent on an empty prompt.
    const { bridge, stubs } = makeBridge('');
    await (bridge as unknown as Internals).handleInbound(dmVoiceCtx(''));

    expect(stubs.downloadFile).toHaveBeenCalledTimes(1); // we still tried
    expect(stubs.startRun).not.toHaveBeenCalled();
    const notes = stubs.chatPostMessage.mock.calls.map((c) => (c[0] as { text: string }).text);
    expect(notes.some((t) => /transcribe/i.test(t))).toBe(true);
  });
});

describe('SlackBridge.buildPromptFromContext — audio detection', () => {
  it('rewrites ctx.text to the transcript for a native clip', async () => {
    const { bridge, stubs } = makeBridge('the transcript');
    const ctx = { ...dmVoiceCtx(''), text: '' };
    await (bridge as unknown as Internals).buildPromptFromContext(ctx);
    expect(ctx.text).toBe('the transcript');
    expect(stubs.ingest).toHaveBeenCalledTimes(1);
  });

  it('leaves a real video mp4 untouched (no download, no STT)', async () => {
    const { bridge, stubs } = makeBridge('should not be used');
    const video: SlackFile = {
      id: 'F_VID',
      name: 'demo.mp4',
      mimetype: 'video/mp4',
      filetype: 'mp4',
      url_private_download: 'https://files.slack.com/demo.mp4',
      size: 999,
    };
    const ctx = { ...dmVoiceCtx('', [video]), text: '' };
    await (bridge as unknown as Internals).buildPromptFromContext(ctx);

    expect(ctx.text).toBe(''); // unchanged — not treated as audio
    expect(stubs.downloadFile).not.toHaveBeenCalled();
    expect(stubs.ingest).not.toHaveBeenCalled();
  });
});
