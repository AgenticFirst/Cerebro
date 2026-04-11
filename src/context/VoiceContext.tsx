import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
} from 'react';
import { useChat } from './ChatContext';
import type {
  VoiceSessionState,
  VoiceSessionEvent,
} from '../voice/types';

// ── Types ────────────────────────────────────────────────────────

interface ActiveSession {
  sessionId: string;
  expertId: string;
  conversationId: string;
}

interface VoiceState {
  sessionState: VoiceSessionState;
  activeSession: ActiveSession | null;
  currentTranscription: string;
  currentResponse: string;
  isSpeaking: boolean;
  subtitlesEnabled: boolean;
  callError: string | null;
  statusMessage: string;
}

interface VoiceActions {
  startCall: (expertId: string) => Promise<void>;
  endCall: () => Promise<void>;
  startSpeaking: () => void;
  stopSpeaking: () => void;
  toggleSubtitles: () => void;
}

type VoiceContextValue = VoiceState & VoiceActions;

const VoiceContext = createContext<VoiceContextValue | null>(null);

// ── Provider ─────────────────────────────────────────────────────

export function VoiceProvider({ children }: { children: ReactNode }) {
  const { setActiveScreen } = useChat();

  const [sessionState, setSessionState] = useState<VoiceSessionState>('idle');
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [currentTranscription, setCurrentTranscription] = useState('');
  const [currentResponse, setCurrentResponse] = useState('');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);
  const [callError, setCallError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');

  const unsubscribeRef = useRef<(() => void) | null>(null);
  const activeSessionRef = useRef<ActiveSession | null>(null);
  const sessionStateRef = useRef<VoiceSessionState>('idle');

  // Keep refs in sync
  useEffect(() => { activeSessionRef.current = activeSession; }, [activeSession]);
  useEffect(() => { sessionStateRef.current = sessionState; }, [sessionState]);

  // Clean up event listener on unmount
  useEffect(() => {
    return () => {
      unsubscribeRef.current?.();
    };
  }, []);

  const startCall = useCallback(
    async (expertId: string) => {
      setActiveScreen('call');
      setCurrentTranscription('');
      setCurrentResponse('');
      setCallError(null);
      setSessionState('initializing');
      setStatusMessage('Setting up conversation...');

      try {
        const conversationId = crypto.randomUUID().replace(/-/g, '');

        setStatusMessage('Creating conversation...');
        await window.cerebro.invoke({
          method: 'POST',
          path: '/conversations',
          body: { id: conversationId, title: 'Voice Call' },
        });

        setStatusMessage('Loading speech recognition model...');
        await window.cerebro.invoke({ method: 'POST', path: '/voice/stt/load' });

        setStatusMessage('Loading voice synthesis model...');
        await window.cerebro.invoke({ method: 'POST', path: '/voice/tts/load' });

        setStatusMessage('Starting call...');

        const sessionId = await window.cerebro.voice.start(expertId, conversationId);

        const session: ActiveSession = { sessionId, expertId, conversationId };
        setActiveSession(session);

        // Subscribe to voice events
        unsubscribeRef.current?.();
        unsubscribeRef.current = window.cerebro.voice.onEvent(sessionId, (event: VoiceSessionEvent) => {
          switch (event.type) {
            case 'state_change':
              setSessionState(event.state);
              if (event.state === 'listening') {
                // Response text stays visible until the next PTT press starts
                // a new interaction (cleared on the next 'transcription' event).
                setStatusMessage('');
                setCallError(null);
              } else if (event.state === 'processing') {
                setCurrentResponse('');
                setStatusMessage('Thinking...');
              } else if (event.state === 'speaking') {
                setStatusMessage('');
              }
              break;
            case 'transcription':
              // Only clear the coach's response when the user FINALIZES a new
              // turn (releases PTT). Partial transcriptions fire repeatedly
              // during PTT hold — and also when the mic picks up TTS audio
              // playback after state transitioned to 'listening'. Clearing
              // on partials was making the subtitles vanish mid-speech.
              if (event.isFinal) {
                setCurrentResponse('');
              }
              setCurrentTranscription(event.text);
              break;
            case 'response_text':
              setCurrentResponse((prev) => prev + event.delta);
              break;
            case 'response_done':
              setCurrentResponse(event.fullText);
              break;
            case 'tts_done':
              break;
            case 'error':
              console.error('[Voice] error:', event.error);
              setCallError(event.error);
              break;
            case 'ended':
              setSessionState('idle');
              setActiveSession(null);
              setStatusMessage('');
              unsubscribeRef.current?.();
              unsubscribeRef.current = null;
              break;
          }
        });

        setSessionState('listening');
        setStatusMessage('');
      } catch (err) {
        console.error('[Voice] Failed to start call:', err);
        const msg = err instanceof Error ? err.message : String(err);
        setSessionState('idle');
        setActiveSession(null);
        setCallError(msg);
        setStatusMessage('');
      }
    },
    [setActiveScreen],
  );

  const endCall = useCallback(async () => {
    if (activeSession) {
      await window.cerebro.voice.stop(activeSession.sessionId);
    }
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    setSessionState('idle');
    setActiveSession(null);
    setCurrentTranscription('');
    setCurrentResponse('');
    setIsSpeaking(false);
    setCallError(null);
    setStatusMessage('');
    setActiveScreen('experts');
  }, [activeSession, setActiveScreen]);

  const startSpeaking = useCallback(() => {
    const state = sessionStateRef.current;
    if (state !== 'listening' && state !== 'speaking') return;
    setIsSpeaking(true);
  }, []);

  const stopSpeaking = useCallback(() => {
    setIsSpeaking(false);
    const session = activeSessionRef.current;
    if (session) {
      window.cerebro.voice.doneSpeaking(session.sessionId);
    }
  }, []);

  const toggleSubtitles = useCallback(() => {
    setSubtitlesEnabled((prev) => !prev);
  }, []);

  const value: VoiceContextValue = {
    sessionState,
    activeSession,
    currentTranscription,
    currentResponse,
    isSpeaking,
    subtitlesEnabled,
    callError,
    statusMessage,
    startCall,
    endCall,
    startSpeaking,
    stopSpeaking,
    toggleSubtitles,
  };

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

// ── Hook ─────────────────────────────────────────────────────────

export function useVoice(): VoiceContextValue {
  const ctx = useContext(VoiceContext);
  if (!ctx) throw new Error('useVoice must be used within VoiceProvider');
  return ctx;
}
