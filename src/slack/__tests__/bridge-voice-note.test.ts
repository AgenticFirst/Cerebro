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
  conversationsReplies: ReturnType<typeof vi.fn>;
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
  // Empty thread/message fetch by default — hydration finds nothing and
  // buildThreadContext backfills nothing, matching the pre-fix baseline.
  const conversationsReplies = vi.fn(async () => [] as unknown[]);

  const bridge = new SlackBridge({
    backendPort: 9,
    agentRuntime: runtime as never,
    dataDir: '/tmp',
    engineEventBus: new EventEmitter(),
  });

  Object.assign(bridge as unknown as Record<string, unknown>, {
    api: {
      downloadFile,
      chatPostMessage,
      chatPostEphemeral: vi.fn(async () => undefined),
      conversationsReplies,
      usersInfo: vi.fn(async () => null),
    },
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

  return {
    bridge,
    stubs: { downloadFile, ingest, startRun, chatPostMessage, conversationsReplies },
  };
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

  it('treats a non-audio file (video mp4) as a generic attachment, not audio', async () => {
    const { bridge, stubs } = makeBridge('should not be used');
    // Generic ingest result — MediaIngestService returns a descriptive injection
    // for video (it has no STT transcript).
    stubs.ingest.mockResolvedValue({ promptInjection: '[video attached at /tmp/demo.mp4]' });
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

    // Downloaded + ingested as a file, NOT routed through the STT/audio branch.
    expect(stubs.downloadFile).toHaveBeenCalledTimes(1);
    expect(stubs.ingest).toHaveBeenCalledTimes(1);
    // The caption text is untouched; the injection rides on attachmentPrompt so
    // history isn't polluted with a dead staging path.
    expect(ctx.text).toBe('');
    expect(ctx.attachmentPrompt).toBe('[video attached at /tmp/demo.mp4]');
    expect(ctx.attachmentSummary).toBe('📎 demo.mp4');
  });

  it('ingests an image/PDF attachment into attachmentPrompt', async () => {
    const { bridge, stubs } = makeBridge('');
    stubs.ingest.mockResolvedValue({
      promptInjection: '@/tmp/report.md\n[parsed from report.pdf]',
    });
    const pdf: SlackFile = {
      id: 'F_PDF',
      name: 'report.pdf',
      mimetype: 'application/pdf',
      filetype: 'pdf',
      url_private_download: 'https://files.slack.com/report.pdf',
      size: 4096,
    };
    const ctx = { ...dmVoiceCtx('', [pdf]), text: '' };
    await (bridge as unknown as Internals).buildPromptFromContext(ctx);

    expect(stubs.downloadFile).toHaveBeenCalledTimes(1);
    expect(stubs.ingest).toHaveBeenCalledTimes(1);
    expect(ctx.attachmentPrompt).toBe('@/tmp/report.md\n[parsed from report.pdf]');
    expect(ctx.attachmentSummary).toBe('📎 report.pdf');
  });
});

/**
 * End-to-end coverage for the original bug: "Cerebro no acepta archivos
 * adjuntados directos desde Slack" — a file attached in Slack was never
 * recognized. These drive the REAL handleInbound (only backend-touching
 * collaborators are stubbed) and assert at the agent-run boundary, so they
 * prove the whole path: detect file → download with the real extension →
 * MediaIngest → injection folded into the run prompt → run actually starts
 * (the empty-body guard no longer drops a caption-less upload).
 */
describe('SlackBridge — non-audio file attachments end-to-end', () => {
  const pdf = (over: Partial<SlackFile> = {}): SlackFile => ({
    id: 'F_PDF',
    name: 'report.pdf',
    mimetype: 'application/pdf',
    filetype: 'pdf',
    url_private_download: 'https://files.slack.com/report.pdf',
    size: 4096,
    ...over,
  });

  function fileCtx(text: string, files: SlackFile[], over: Record<string, unknown> = {}) {
    return { ...dmVoiceCtx(text, files), text, ...over } as ReturnType<typeof dmVoiceCtx>;
  }

  it('starts a run for a CAPTION-LESS file — the exact regression that was reported', async () => {
    const { bridge, stubs } = makeBridge('');
    stubs.ingest.mockResolvedValue({
      promptInjection: '@/tmp/report.md\n[parsed from report.pdf]',
    });

    await (bridge as unknown as Internals).handleInbound(fileCtx('', [pdf()]));

    // Downloaded with the REAL extension so MediaIngest categorizes it (a .pdf,
    // not a generic .bin) — and the old code returned before this point.
    expect(stubs.downloadFile).toHaveBeenCalledTimes(1);
    expect(stubs.downloadFile.mock.calls[0][1] as string).toMatch(/\.pdf$/);
    expect(stubs.ingest).toHaveBeenCalledTimes(1);
    // THE fix: a file with no text survived the empty-body guard and reached the
    // agent run with the parsed-file injection as its content.
    expect(stubs.startRun).toHaveBeenCalledTimes(1);
    const runRequest = stubs.startRun.mock.calls[0][1] as { content: string };
    expect(runRequest.content).toBe('@/tmp/report.md\n[parsed from report.pdf]');
  });

  it('prepends the file injection ahead of a typed caption', async () => {
    const { bridge, stubs } = makeBridge('');
    stubs.ingest.mockResolvedValue({ promptInjection: '@/tmp/report.md' });

    await (bridge as unknown as Internals).handleInbound(fileCtx('please summarise', [pdf()]));

    const runRequest = stubs.startRun.mock.calls[0][1] as { content: string };
    expect(runRequest.content).toBe('@/tmp/report.md\n\nplease summarise');
  });

  it('ingests MULTIPLE attached files and joins their injections', async () => {
    const { bridge, stubs } = makeBridge('');
    stubs.ingest
      .mockResolvedValueOnce({ promptInjection: '@/tmp/a.md' })
      .mockResolvedValueOnce({ promptInjection: '@/tmp/b.png' });
    const img: SlackFile = {
      id: 'F_IMG',
      name: 'b.png',
      mimetype: 'image/png',
      filetype: 'png',
      url_private_download: 'https://files.slack.com/b.png',
      size: 2048,
    };

    await (bridge as unknown as Internals).handleInbound(
      fileCtx('', [pdf({ id: 'F_A', name: 'a.pdf' }), img]),
    );

    expect(stubs.downloadFile).toHaveBeenCalledTimes(2);
    expect(stubs.ingest).toHaveBeenCalledTimes(2);
    const runRequest = stubs.startRun.mock.calls[0][1] as { content: string };
    expect(runRequest.content).toBe('@/tmp/a.md\n\n@/tmp/b.png');
  });

  it('persists a human-readable label (not the @path) when there is no caption', async () => {
    const { bridge, stubs } = makeBridge('');
    stubs.ingest.mockResolvedValue({ promptInjection: '@/tmp/secret-staging-path.md' });

    await (bridge as unknown as Internals).handleInbound(fileCtx('', [pdf()]));

    // The ctx handed to persistence carries the label + empty text, so the
    // persisted body resolves to "📎 report.pdf" rather than a staging path that
    // is TTL-deleted minutes later.
    const persist = (bridge as unknown as Record<string, { mock: { calls: unknown[][] } }>)
      .postUserMessageWithRecovery;
    const persistedCtx = persist.mock.calls[0][1] as {
      text: string;
      attachmentSummary?: string;
    };
    expect(persistedCtx.text).toBe('');
    expect(persistedCtx.attachmentSummary).toBe('📎 report.pdf');
    // Sanity: the agent still received the real injection, not the label.
    expect((stubs.startRun.mock.calls[0][1] as { content: string }).content).toBe(
      '@/tmp/secret-staging-path.md',
    );
  });

  it('skips an OVERSIZE file and does NOT start a run when there is no caption', async () => {
    const { bridge, stubs } = makeBridge('');

    await (bridge as unknown as Internals).handleInbound(
      fileCtx('', [pdf({ size: 25 * 1024 * 1024 })]),
    );

    expect(stubs.downloadFile).not.toHaveBeenCalled();
    expect(stubs.ingest).not.toHaveBeenCalled();
    expect(stubs.startRun).not.toHaveBeenCalled();
    const notes = stubs.chatPostMessage.mock.calls.map((c) => (c[0] as { text: string }).text);
    expect(notes.some((t) => /too large/i.test(t))).toBe(true);
  });

  it('still answers a typed caption even when the attached file is oversize', async () => {
    const { bridge, stubs } = makeBridge('');

    await (bridge as unknown as Internals).handleInbound(
      fileCtx('what do you make of this?', [pdf({ size: 25 * 1024 * 1024 })]),
    );

    expect(stubs.startRun).toHaveBeenCalledTimes(1);
    expect((stubs.startRun.mock.calls[0][1] as { content: string }).content).toBe(
      'what do you make of this?',
    );
  });

  it('does NOT start a run when the download fails and there is no caption', async () => {
    const { bridge, stubs } = makeBridge('');
    stubs.downloadFile.mockRejectedValue(new Error('network boom'));

    await (bridge as unknown as Internals).handleInbound(fileCtx('', [pdf()]));

    expect(stubs.downloadFile).toHaveBeenCalledTimes(1);
    expect(stubs.ingest).not.toHaveBeenCalled();
    expect(stubs.startRun).not.toHaveBeenCalled();
    const notes = stubs.chatPostMessage.mock.calls.map((c) => (c[0] as { text: string }).text);
    expect(notes.some((t) => /couldn't fetch that file/i.test(t))).toBe(true);
  });

  it('does NOT start a run when ingest returns an empty injection (no caption)', async () => {
    const { bridge, stubs } = makeBridge('');
    stubs.ingest.mockResolvedValue({ promptInjection: '   ' }); // blank → unusable

    await (bridge as unknown as Internals).handleInbound(fileCtx('', [pdf()]));

    expect(stubs.downloadFile).toHaveBeenCalledTimes(1);
    expect(stubs.startRun).not.toHaveBeenCalled();
  });

  it('keeps the injection when an @mention with a file arrives inside a thread', async () => {
    const { bridge, stubs } = makeBridge('');
    stubs.ingest.mockResolvedValue({ promptInjection: '@/tmp/spec.md' });

    // channel + thread_ts → conversationKey resolves to the "thread" surface,
    // which runs the thread-context branch. conversationsReplies returns no
    // messages here, so the run content is the injection + caption — proving
    // that branch wraps promptContent (with the injection), not the bare
    // caption as it did before the fix.
    await (bridge as unknown as Internals).handleInbound(
      fileCtx('check the spec', [pdf({ name: 'spec.pdf' })], {
        channelType: 'channel',
        surface: 'app_mention',
        threadTs: '111.000',
      }),
    );

    expect(stubs.startRun).toHaveBeenCalledTimes(1);
    expect((stubs.startRun.mock.calls[0][1] as { content: string }).content).toBe(
      '@/tmp/spec.md\n\ncheck the spec',
    );
  });

  it('audio still takes precedence — a voice note is transcribed, not file-ingested', async () => {
    // Regression guard: when both an audio clip and the audio path apply, we
    // transcribe (existing behavior) and never fall through to file ingest.
    const { bridge, stubs } = makeBridge('the spoken words');

    await (bridge as unknown as Internals).handleInbound(dmVoiceCtx(''));

    expect(stubs.startRun).toHaveBeenCalledTimes(1);
    expect((stubs.startRun.mock.calls[0][1] as { content: string }).content).toBe(
      'the spoken words',
    );
  });

  it('does NOT persist an "(empty message)" row for a content-less failed upload', async () => {
    // Fix for the persistence quirk: a failed media upload with no caption must
    // bail out BEFORE persistence so it leaves no empty row behind.
    const { bridge, stubs } = makeBridge('');
    stubs.downloadFile.mockRejectedValue(new Error('network boom'));

    await (bridge as unknown as Internals).handleInbound(fileCtx('', [pdf()]));

    const persist = (bridge as unknown as Record<string, { mock: { calls: unknown[][] } }>)
      .postUserMessageWithRecovery;
    expect(persist.mock.calls.length).toBe(0);
    expect(stubs.startRun).not.toHaveBeenCalled();
  });

  it('localizes the oversize note to Spanish when ui_language is es', async () => {
    const { bridge, stubs } = makeBridge('');
    (bridge as unknown as { appLanguage: string }).appLanguage = 'es';

    await (bridge as unknown as Internals).handleInbound(
      fileCtx('', [pdf({ size: 25 * 1024 * 1024 })]),
    );

    const notes = stubs.chatPostMessage.mock.calls.map((c) => (c[0] as { text: string }).text);
    expect(notes.some((t) => /demasiado grande/i.test(t))).toBe(true);
  });

  it('recovers a STRIPPED file object (no url_private) via files.info', async () => {
    // Slack Connect / `file_access: "check_file_info"` events deliver file
    // entries without url_private — the bridge must fetch the full object
    // via files.info instead of silently dropping the message.
    const { bridge, stubs } = makeBridge('the spoken words');
    const filesInfo = vi.fn(async () => ({
      ...NATIVE_VOICE_CLIP,
      url_private_download: 'https://files.slack.com/refetched.mp4',
    }));
    ((bridge as unknown as Record<string, unknown>).api as Record<string, unknown>).filesInfo =
      filesInfo;
    const stripped: SlackFile = { ...NATIVE_VOICE_CLIP, url_private_download: undefined };

    await (bridge as unknown as Internals).handleInbound(dmVoiceCtx('', [stripped]));

    expect(filesInfo).toHaveBeenCalledWith('F_VOICE');
    expect(stubs.downloadFile).toHaveBeenCalledTimes(1);
    expect(stubs.downloadFile.mock.calls[0][0]).toBe('https://files.slack.com/refetched.mp4');
    expect(stubs.startRun).toHaveBeenCalledTimes(1);
    expect((stubs.startRun.mock.calls[0][1] as { content: string }).content).toBe(
      'the spoken words',
    );
  });

  it('notifies the user (never a silent drop) when no download URL is recoverable', async () => {
    const { bridge, stubs } = makeBridge('unused');
    ((bridge as unknown as Record<string, unknown>).api as Record<string, unknown>).filesInfo =
      vi.fn(async () => null);
    const stripped: SlackFile = { ...NATIVE_VOICE_CLIP, url_private_download: undefined };

    await (bridge as unknown as Internals).handleInbound(dmVoiceCtx('', [stripped]));

    expect(stubs.downloadFile).not.toHaveBeenCalled();
    expect(stubs.startRun).not.toHaveBeenCalled();
    const notes = stubs.chatPostMessage.mock.calls.map((c) => (c[0] as { text: string }).text);
    expect(notes.some((t) => /didn't give me access to that voice note/i.test(t))).toBe(true);
  });

  it('localizes the "got files" ack and the download-failure note to Spanish', async () => {
    // ack path
    const ok = makeBridge('');
    (ok.bridge as unknown as { appLanguage: string }).appLanguage = 'es';
    ok.stubs.ingest.mockResolvedValue({ promptInjection: '@/tmp/x.md' });
    await (ok.bridge as unknown as Internals).handleInbound(fileCtx('', [pdf()]));
    const okNotes = ok.stubs.chatPostMessage.mock.calls.map((c) => (c[0] as { text: string }).text);
    expect(okNotes.some((t) => /Recibí/i.test(t))).toBe(true);

    // failure path uses the file-flavored Spanish string, not the voice one
    const fail = makeBridge('');
    (fail.bridge as unknown as { appLanguage: string }).appLanguage = 'es';
    fail.stubs.downloadFile.mockRejectedValue(new Error('boom'));
    await (fail.bridge as unknown as Internals).handleInbound(fileCtx('', [pdf()]));
    const failNotes = fail.stubs.chatPostMessage.mock.calls.map(
      (c) => (c[0] as { text: string }).text,
    );
    expect(failNotes.some((t) => /No pude obtener ese archivo/i.test(t))).toBe(true);
  });
});

/**
 * Channel-mention file hydration — regression for "Cerebro no acepta archivos
 * adjuntados directos desde Slack" as seen in CHANNELS. Slack's `app_mention`
 * event payload never includes `files[]` (they ride only on `message` events,
 * which we don't subscribe to for channels), so the bridge must re-fetch the
 * mention message via conversations.replies to see its attachments.
 */
describe('SlackBridge — app_mention file hydration', () => {
  const PDF: SlackFile = {
    id: 'F_PDF',
    name: 'report.pdf',
    mimetype: 'application/pdf',
    filetype: 'pdf',
    url_private_download: 'https://files.slack.com/report.pdf',
    size: 4096,
  };

  /** A channel @mention as Bolt delivers it: files are NEVER on the event. */
  function mentionCtx(text: string, over: Record<string, unknown> = {}) {
    return {
      eventId: 'Ev_mention',
      teamId: 'T1',
      channel: 'C1',
      channelType: 'channel' as const,
      userId: 'U1',
      ts: '123.456',
      threadTs: undefined,
      text,
      files: undefined,
      surface: 'app_mention' as const,
      ...over,
    } as unknown as ReturnType<typeof dmVoiceCtx>;
  }

  it('recovers a file the app_mention event did not carry — the reported bug', async () => {
    const { bridge, stubs } = makeBridge('');
    stubs.ingest.mockResolvedValue({ promptInjection: '@/tmp/report.md' });
    stubs.conversationsReplies.mockResolvedValue([
      { ts: '123.456', user: 'U1', text: '<@UBOT> summarize this', files: [PDF] },
    ]);

    await (bridge as unknown as Internals).handleInbound(mentionCtx('summarize this'));

    // Top-level mention → fetched by the message's own ts.
    expect(stubs.conversationsReplies).toHaveBeenCalledTimes(1);
    expect(stubs.conversationsReplies.mock.calls[0][0]).toEqual({
      channel: 'C1',
      ts: '123.456',
      limit: 200,
    });
    // The hydrated file flowed through the normal ingest path into the run.
    expect(stubs.downloadFile).toHaveBeenCalledTimes(1);
    expect(stubs.downloadFile.mock.calls[0][1] as string).toMatch(/\.pdf$/);
    expect(stubs.startRun).toHaveBeenCalledTimes(1);
    expect((stubs.startRun.mock.calls[0][1] as { content: string }).content).toBe(
      '@/tmp/report.md\n\nsummarize this',
    );
  });

  it('selects the mention message by ts when the mention is inside a thread', async () => {
    const { bridge, stubs } = makeBridge('');
    stubs.ingest.mockResolvedValue({ promptInjection: '@/tmp/spec.md' });
    stubs.conversationsReplies.mockResolvedValue([
      // Thread root: no files, blank text so buildThreadContext has nothing to
      // backfill and the content assertion below stays exact.
      { ts: '111.000', user: 'U2', text: '' },
      { ts: '123.456', user: 'U1', text: '<@UBOT> check this', files: [PDF] },
    ]);

    await (bridge as unknown as Internals).handleInbound(
      mentionCtx('check this', { threadTs: '111.000' }),
    );

    // Threaded mention → fetched by the thread root's ts (shared with the
    // thread-context backfill, which also calls conversations.replies).
    const hydrationCall = stubs.conversationsReplies.mock.calls[0][0] as { ts: string };
    expect(hydrationCall.ts).toBe('111.000');
    expect(stubs.downloadFile).toHaveBeenCalledTimes(1);
    expect((stubs.startRun.mock.calls[0][1] as { content: string }).content).toBe(
      '@/tmp/spec.md\n\ncheck this',
    );
  });

  it('hydrates a voice note too — the STT branch runs off the recovered file', async () => {
    const { bridge, stubs } = makeBridge('the spoken words');
    stubs.conversationsReplies.mockResolvedValue([
      { ts: '123.456', user: 'U1', text: '', files: [NATIVE_VOICE_CLIP] },
    ]);

    await (bridge as unknown as Internals).handleInbound(mentionCtx(''));

    expect(stubs.downloadFile.mock.calls[0][1] as string).toMatch(/\.m4a$/);
    expect(stubs.startRun).toHaveBeenCalledTimes(1);
    expect((stubs.startRun.mock.calls[0][1] as { content: string }).content).toBe(
      'the spoken words',
    );
  });

  it('degrades to text-only when the fetch fails (old install missing history scopes)', async () => {
    const { bridge, stubs } = makeBridge('');
    stubs.conversationsReplies.mockRejectedValue(new Error('missing_scope'));

    await (bridge as unknown as Internals).handleInbound(mentionCtx('hello there'));

    expect(stubs.downloadFile).not.toHaveBeenCalled();
    expect(stubs.startRun).toHaveBeenCalledTimes(1);
    expect((stubs.startRun.mock.calls[0][1] as { content: string }).content).toBe('hello there');
  });

  it('a text-only mention still runs normally after an empty hydration', async () => {
    const { bridge, stubs } = makeBridge('');
    stubs.conversationsReplies.mockResolvedValue([
      { ts: '123.456', user: 'U1', text: '<@UBOT> just a question' },
    ]);

    await (bridge as unknown as Internals).handleInbound(mentionCtx('just a question'));

    expect(stubs.downloadFile).not.toHaveBeenCalled();
    expect(stubs.ingest).not.toHaveBeenCalled();
    expect((stubs.startRun.mock.calls[0][1] as { content: string }).content).toBe(
      'just a question',
    );
  });

  it('never hydrates DMs — message.im events already carry files', async () => {
    const { bridge, stubs } = makeBridge('the spoken words');

    await (bridge as unknown as Internals).handleInbound(dmVoiceCtx(''));

    expect(stubs.conversationsReplies).not.toHaveBeenCalled();
    expect(stubs.startRun).toHaveBeenCalledTimes(1);
  });

  it('skips the fetch when the event somehow carried files already', async () => {
    const { bridge, stubs } = makeBridge('');
    stubs.ingest.mockResolvedValue({ promptInjection: '@/tmp/report.md' });

    await (bridge as unknown as Internals).handleInbound(mentionCtx('look', { files: [PDF] }));

    expect(stubs.conversationsReplies).not.toHaveBeenCalled();
    expect(stubs.downloadFile).toHaveBeenCalledTimes(1);
  });
});
