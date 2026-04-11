/**
 * VoiceSession — manages one active voice call between the user and an expert.
 *
 * Runs in the Electron main process. Mediates audio between the renderer
 * (mic capture / speaker playback) and the Python backend (STT / TTS),
 * and uses VoiceClaudeRunner for fast, lightweight LLM turns.
 *
 * Push-to-talk flow:
 *   User holds PTT → audio chunks buffered → user releases PTT →
 *   buffer sent to STT → transcription → VoiceClaudeRunner → TTS (serialized queue) →
 *   back to waiting for PTT.
 *
 * State machine: IDLE → INITIALIZING → LISTENING → PROCESSING → SPEAKING → LISTENING (loop)
 */

import http from 'node:http';
import type { WebContents } from 'electron';
import { IPC_CHANNELS } from '../types/ipc';
import type { VoiceSessionState, VoiceSessionEvent } from './types';
import { VoiceClaudeRunner } from './claude-runner';
import { fireVoiceMemoryUpdate } from './memory-updater';
import { generateId } from '../context/chat-helpers';

interface VoiceSkill {
  name: string;
  instructions: string;
}

interface SessionInfo {
  sessionId: string;
  expertId: string;
  expertName: string;
  expertDomain: string | null;
  conversationId: string;
  state: VoiceSessionState;
  audioBuffer: Buffer[];
  currentRunner: VoiceClaudeRunner | null;
  responseSentenceBuffer: string;
  ttsAbortController: AbortController | null;
  ttsQueue: string[];
  ttsProcessing: boolean;
  /** Full system prompt (expert identity + skills + voice instructions). */
  fullSystemPrompt: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  partialTimer: ReturnType<typeof setTimeout> | null;
  partialInFlight: boolean;
}

const VOICE_MODEL = 'claude-haiku-4-5';
const MAX_HISTORY_TURNS = 10;
const PARTIAL_FIRST_DELAY_MS = 600;
const PARTIAL_NEXT_DELAY_MS = 800;
const LISTEN_HANDOFF_DELAY_MS = 500;
const LISTEN_HANDOFF_DELAY_NO_AUDIO_MS = 4000;
const MIN_AUDIO_BYTES_FULL = 16000;
const MIN_AUDIO_BYTES_PARTIAL = 9600;

const SENTENCE_RE = /^(.*?[.!?])\s+(.*)$/s;

const VOICE_INSTRUCTIONS = `You are in a live voice conversation. Respond naturally and conversationally, as if speaking. Keep responses concise and direct — aim for 1-3 sentences unless a longer answer is truly needed. Do not use any tools. Do not output markdown formatting, code blocks, or bullet lists — speak in plain prose.`;

interface ExpertSummary {
  name: string;
  domain?: string | null;
  system_prompt?: string | null;
}

function buildVoiceSystemPrompt(expert: ExpertSummary, skills: VoiceSkill[]): string {
  const domainLine = expert.domain ? ` Domain: ${expert.domain}.` : '';
  const identity = (expert.system_prompt ?? '').trim();

  let body = `You are **${expert.name}**, a Cerebro specialist expert.${domainLine}`;

  if (identity) {
    body += `\n\n${identity}`;
  }

  if (skills.length > 0) {
    body += '\n\n## Skills\n\nYou have the following skills. Follow their instructions when relevant:\n';
    for (const skill of skills) {
      body += `\n### ${skill.name}\n\n${skill.instructions.trimEnd()}\n`;
    }
  }

  body += `\n\n---\n\n${VOICE_INSTRUCTIONS}`;
  return body;
}

export class VoiceSessionManager {
  private session: SessionInfo | null = null;
  private backendPort: number;
  private dataDir: string;
  private webContents: WebContents | null = null;

  constructor(backendPort: number, dataDir: string) {
    this.backendPort = backendPort;
    this.dataDir = dataDir;
  }

  setWebContents(wc: WebContents): void {
    this.webContents = wc;
  }

  // ── Public API ──────────────────────────────────────────────────

  async start(expertId: string, conversationId: string): Promise<string> {
    if (this.session) {
      await this.stop();
    }

    const sessionId = generateId().slice(0, 16);

    const [expert, skillsResp] = await Promise.all([
      this.backendGet<{
        id: string;
        name: string;
        domain: string | null;
        system_prompt: string | null;
      }>(`/experts/${expertId}`),
      this.backendGet<{
        skills: Array<{
          is_active: boolean;
          skill: { name: string; instructions: string };
        }>;
      }>(`/experts/${expertId}/skills`),
    ]);

    const activeSkills: VoiceSkill[] = (skillsResp?.skills ?? [])
      .filter((s) => s.is_active)
      .map((s) => ({ name: s.skill.name, instructions: s.skill.instructions }));

    const fullSystemPrompt = buildVoiceSystemPrompt(
      expert ?? { name: 'Assistant', domain: null, system_prompt: null },
      activeSkills,
    );

    this.session = {
      sessionId,
      expertId,
      expertName: expert?.name ?? 'Assistant',
      expertDomain: expert?.domain ?? null,
      conversationId,
      state: 'initializing',
      audioBuffer: [],
      currentRunner: null,
      responseSentenceBuffer: '',
      ttsAbortController: null,
      ttsQueue: [],
      ttsProcessing: false,
      fullSystemPrompt,
      history: [],
      partialTimer: null,
      partialInFlight: false,
    };

    this.emit({ type: 'state_change', state: 'initializing' });

    try {
      // Ensure STT and TTS models are loaded
      const sttResult = await this.backendPost('/voice/stt/load', {});
      if (!sttResult) {
        throw new Error('Failed to load STT model — is it downloaded?');
      }
      const ttsResult = await this.backendPost('/voice/tts/load', {});
      if (!ttsResult) {
        throw new Error('Failed to load TTS model — is it downloaded?');
      }

      this.setState('listening');
      return sessionId;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'error', error: `Failed to initialize voice session: ${error}` });
      this.session = null;
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.session) return;

    this.cancelPartialTranscription();

    if (this.session.currentRunner) {
      this.session.currentRunner.abort();
      this.session.currentRunner = null;
    }

    if (this.session.ttsAbortController) {
      this.session.ttsAbortController.abort();
    }

    this.session.ttsQueue = [];

    // Fire end-of-call memory update if we have at least one complete turn
    // (user spoke AND expert responded). Detached subprocess survives quit.
    const s = this.session;
    const lastTurn = s.history[s.history.length - 1];
    if (s.history.length >= 2 && lastTurn?.role === 'assistant') {
      fireVoiceMemoryUpdate({
        dataDir: this.dataDir,
        expertId: s.expertId,
        expertName: s.expertName,
        expertDomain: s.expertDomain,
        transcript: [...s.history],
      });
    }

    this.emit({ type: 'ended' });
    this.session = null;
  }

  /** Buffer incoming audio chunks (only while user is holding PTT). */
  async processAudioChunk(sessionId: string, chunk: Buffer): Promise<void> {
    if (!this.session || this.session.sessionId !== sessionId) return;

    if (this.session.state === 'speaking') {
      await this.handleBargeIn();
    }

    if (this.session.state !== 'listening') return;

    this.session.audioBuffer.push(chunk);
    this.schedulePartialTranscription();
  }

  /** Called when the user releases the PTT button — process the buffered audio. */
  async doneSpeaking(sessionId: string): Promise<void> {
    if (!this.session || this.session.sessionId !== sessionId) return;
    if (this.session.state !== 'listening') return;
    if (this.session.audioBuffer.length === 0) return;

    this.cancelPartialTranscription();
    this.setState('processing');

    const fullAudio = Buffer.concat(this.session.audioBuffer);
    this.session.audioBuffer = [];

    if (fullAudio.length < MIN_AUDIO_BYTES_FULL) {
      this.setState('listening');
      return;
    }

    try {
      const result = await this.backendPost<{
        text: string;
        segments: Array<{ start: number; end: number; text: string }>;
        language: string;
      }>('/voice/stt/transcribe', {
        audio_base64: fullAudio.toString('base64'),
        sample_rate: 16000,
      });

      if (!result) {
        this.emit({ type: 'error', error: 'Speech recognition failed — please try again' });
        this.setState('listening');
        return;
      }

      if (!result.text.trim()) {
        this.setState('listening');
        return;
      }

      this.emit({ type: 'transcription', text: result.text, isFinal: true });

      this.backendPost(`/conversations/${this.session.conversationId}/messages`, {
        id: generateId(),
        role: 'user',
        content: result.text,
        metadata: { type: 'voice_call' },
      }).catch((err) => console.error('[Voice] persist user message failed:', err));

      this.session.history.push({ role: 'user', content: result.text });

      await this.processWithRunner(result.text);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error('[Voice] transcription error:', error);
      this.emit({ type: 'error', error: `Transcription failed: ${error}` });
      this.setState('listening');
    }
  }

  getModelStatus(): Promise<unknown> {
    return this.backendGet('/voice/status');
  }

  get activeSessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  private schedulePartialTranscription(): void {
    if (!this.session) return;
    if (this.session.partialTimer || this.session.partialInFlight) return;

    const delay = this.session.audioBuffer.length <= 1 ? PARTIAL_FIRST_DELAY_MS : PARTIAL_NEXT_DELAY_MS;
    this.session.partialTimer = setTimeout(() => {
      this.runPartialTranscription();
    }, delay);
  }

  private cancelPartialTranscription(): void {
    if (!this.session) return;
    if (this.session.partialTimer) {
      clearTimeout(this.session.partialTimer);
      this.session.partialTimer = null;
    }
  }

  private async runPartialTranscription(): Promise<void> {
    if (!this.session || this.session.state !== 'listening') return;
    if (this.session.audioBuffer.length === 0) return;

    this.session.partialTimer = null;
    this.session.partialInFlight = true;

    const audio = Buffer.concat(this.session.audioBuffer);

    if (audio.length < MIN_AUDIO_BYTES_PARTIAL) {
      this.session.partialInFlight = false;
      return;
    }

    try {
      const result = await this.backendPost<{
        text: string;
        segments: Array<{ start: number; end: number; text: string }>;
        language: string;
      }>('/voice/stt/transcribe', {
        audio_base64: audio.toString('base64'),
        sample_rate: 16000,
      });

      if (result?.text?.trim() && this.session?.state === 'listening') {
        this.emit({ type: 'transcription', text: result.text, isFinal: false });
      }
    } catch {
      // Partial transcription errors are non-critical
    } finally {
      if (this.session) {
        this.session.partialInFlight = false;
        if (this.session.state === 'listening' && this.session.audioBuffer.length > 0) {
          this.schedulePartialTranscription();
        }
      }
    }
  }

  private async processWithRunner(userText: string): Promise<void> {
    if (!this.session) return;

    const runId = generateId().slice(0, 16);
    const runner = new VoiceClaudeRunner();

    this.session.currentRunner = runner;
    this.session.responseSentenceBuffer = '';
    this.session.ttsQueue = [];

    runner.on('text_delta', (delta: string) => {
      if (!this.session || this.session.currentRunner !== runner) return;

      this.session.responseSentenceBuffer += delta;
      this.emit({ type: 'response_text', delta });
      this.checkAndStreamSentence();
    });

    runner.on('done', (fullText: string) => {
      if (!this.session) return;
      this.session.currentRunner = null;
      this.emit({ type: 'response_done', fullText });

      this.session.history.push({ role: 'assistant', content: fullText });
      if (this.session.history.length > MAX_HISTORY_TURNS * 2) {
        this.session.history = this.session.history.slice(-MAX_HISTORY_TURNS * 2);
      }

      this.backendPost(`/conversations/${this.session.conversationId}/messages`, {
        id: generateId(),
        role: 'assistant',
        content: fullText,
        metadata: { type: 'voice_call' },
      }).catch((err) => console.error('[Voice] persist assistant message failed:', err));

      const remaining = this.session.responseSentenceBuffer.trim();
      const ttsPending = this.session.ttsQueue.length > 0 || this.session.ttsProcessing;

      if (remaining) {
        if (this.session.state !== 'speaking') this.setState('speaking');
        this.enqueueTTS(remaining);
        this.session.responseSentenceBuffer = '';
      } else if (!ttsPending && fullText.trim()) {
        if (this.session.state !== 'speaking') this.setState('speaking');
        this.enqueueTTS(fullText.trim());
      } else if (!ttsPending) {
        this.scheduleListenHandoff(LISTEN_HANDOFF_DELAY_NO_AUDIO_MS);
      }
    });

    runner.on('error', (error: string) => {
      if (!this.session) return;
      console.error('[Voice] runner error:', error);
      this.session.currentRunner = null;
      this.emit({ type: 'error', error: `Expert failed to respond: ${error}` });
      this.setState('listening');
    });

    runner.start({
      runId,
      userMessage: userText,
      systemPrompt: this.session.fullSystemPrompt,
      history: this.session.history.slice(0, -1),
      model: VOICE_MODEL,
      cwd: this.dataDir,
    });
  }

  /** Extract complete sentences from the buffer and enqueue for TTS. */
  private checkAndStreamSentence(): void {
    if (!this.session) return;

    while (true) {
      const match = this.session.responseSentenceBuffer.match(SENTENCE_RE);
      if (!match) break;

      const sentence = match[1].trim();
      this.session.responseSentenceBuffer = match[2];

      if (sentence) {
        if (this.session.state !== 'speaking') this.setState('speaking');
        this.enqueueTTS(sentence);
      }
    }
  }

  private enqueueTTS(text: string): void {
    if (!this.session) return;
    this.session.ttsQueue.push(text);
    this.processTTSQueue();
  }

  /** Schedule a deferred transition to 'listening', guarded against races. */
  private scheduleListenHandoff(delayMs: number): void {
    setTimeout(() => {
      const s = this.session;
      if (s && s.state === 'speaking' && !s.currentRunner && !s.ttsProcessing) {
        this.setState('listening');
      }
    }, delayMs);
  }

  /** Process TTS queue one sentence at a time (prevents concurrent llama_decode). */
  private async processTTSQueue(): Promise<void> {
    if (!this.session || this.session.ttsProcessing) return;
    this.session.ttsProcessing = true;

    let audioChunksReceived = false;

    try {
      while (this.session && this.session.ttsQueue.length > 0) {
        const sentence = this.session.ttsQueue.shift()!;
        const hadAudio = await this.streamTTS(sentence);
        if (hadAudio) audioChunksReceived = true;
      }
    } finally {
      if (this.session) {
        this.session.ttsProcessing = false;
        if (this.session.state === 'speaking' && !this.session.currentRunner) {
          this.scheduleListenHandoff(
            audioChunksReceived ? LISTEN_HANDOFF_DELAY_MS : LISTEN_HANDOFF_DELAY_NO_AUDIO_MS,
          );
        }
      }
    }
  }

  /** Stream TTS audio for a sentence. Returns true if any audio chunks were received. */
  private async streamTTS(text: string): Promise<boolean> {
    if (!this.session) return false;

    const controller = new AbortController();
    this.session.ttsAbortController = controller;
    let audioReceived = false;

    try {
      const response = this.backendPostStream('/voice/tts/synthesize', {
        text,
        speaker: 'tara',
      }, controller.signal);

      // Parse SSE stream
      let buffer = '';
      for await (const chunk of response) {
        if (controller.signal.aborted) break;

        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.done) {
              this.emit({ type: 'tts_done' });
              continue;
            }
            if (data.audio) {
              audioReceived = true;
              this.emit({ type: 'tts_audio', chunk: data.audio });
            }
          } catch {
            // Skip malformed lines
          }
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return audioReceived;
      const error = err instanceof Error ? err.message : String(err);
      console.error('[Voice] TTS stream error:', error);
      this.emit({ type: 'error', error: `TTS failed: ${error}` });
    } finally {
      if (this.session?.ttsAbortController === controller) {
        this.session.ttsAbortController = null;
      }
    }

    return audioReceived;
  }

  private async handleBargeIn(): Promise<void> {
    if (!this.session) return;

    this.cancelPartialTranscription();

    if (this.session.currentRunner) {
      this.session.currentRunner.abort();
      this.session.currentRunner = null;
    }

    if (this.session.ttsAbortController) {
      this.session.ttsAbortController.abort();
      this.session.ttsAbortController = null;
    }

    this.session.ttsQueue = [];

    this.emit({ type: 'tts_done' });
    this.session.responseSentenceBuffer = '';
    this.setState('listening');
  }

  private setState(state: VoiceSessionState): void {
    if (!this.session) return;
    this.session.state = state;
    // Drop any buffered audio when transitioning back to listening so the
    // next PTT press starts with a clean capture window.
    if (state === 'listening') {
      this.session.audioBuffer = [];
    }
    this.emit({ type: 'state_change', state });
  }

  private emit(event: VoiceSessionEvent): void {
    if (!this.session || !this.webContents || this.webContents.isDestroyed()) return;
    const channel = IPC_CHANNELS.voiceEvent(this.session.sessionId);
    this.webContents.send(channel, event);
  }

  private backendGet<T>(path: string): Promise<T | null> {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${this.backendPort}${path}`, (res) => {
        if (res.statusCode !== 200) {
          resolve(null);
          res.resume();
          return;
        }
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try { resolve(JSON.parse(data) as T); } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(30_000, () => { req.destroy(); resolve(null); });
    });
  }

  private backendPost<T>(path: string, body: unknown): Promise<T | null> {
    return new Promise((resolve) => {
      const bodyStr = JSON.stringify(body);
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: this.backendPort,
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr).toString(),
          },
          timeout: 60_000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 400) {
              console.error(`[Voice] POST ${path} → ${res.statusCode}: ${data.slice(0, 200)}`);
              resolve(null);
              return;
            }
            try { resolve(JSON.parse(data) as T); } catch { resolve(null); }
          });
        },
      );
      req.on('error', (err) => {
        console.error(`[Voice] POST ${path} error:`, err.message);
        resolve(null);
      });
      req.on('timeout', () => {
        console.error(`[Voice] POST ${path} timed out`);
        req.destroy();
        resolve(null);
      });
      req.write(bodyStr);
      req.end();
    });
  }

  private async *backendPostStream(
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): AsyncGenerator<string> {
    const bodyStr = JSON.stringify(body);

    const response = await new Promise<http.IncomingMessage | null>((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: this.backendPort,
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr).toString(),
            Accept: 'text/event-stream',
          },
          timeout: 120_000,
        },
        (res) => resolve(res),
      );

      signal.addEventListener(
        'abort',
        () => { req.destroy(); resolve(null); },
        { once: true },
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(bodyStr);
      req.end();
    });

    if (!response) return;

    for await (const chunk of response) {
      if (signal.aborted) break;
      yield chunk.toString();
    }
  }
}
