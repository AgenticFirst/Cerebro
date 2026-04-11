// ── Voice session state machine ───────────────────────────────────

export type VoiceSessionState =
  | 'idle'
  | 'initializing'
  | 'listening'
  | 'processing'
  | 'speaking';

// ── Events from main process → renderer ──────────────────────────

export type VoiceSessionEvent =
  | { type: 'state_change'; state: VoiceSessionState }
  | { type: 'transcription'; text: string; isFinal: boolean }
  | { type: 'response_text'; delta: string }
  | { type: 'response_done'; fullText: string }
  | { type: 'tts_audio'; chunk: string }  // base64-encoded PCM int16
  | { type: 'tts_done' }
  | { type: 'error'; error: string }
  | { type: 'ended' };

// ── Voice model info (from backend /voice/catalog) ──────────────

export type VoiceModelType = 'stt' | 'tts';

export interface VoiceModelInfo {
  id: string;
  name: string;
  type: VoiceModelType;
  description: string;
  sizeBytes: number;
  available: boolean;
}

export const SPEAKERS = ['tara', 'leah', 'jess', 'leo', 'dan', 'mia', 'zac', 'zoe'] as const;
export type Speaker = (typeof SPEAKERS)[number];
