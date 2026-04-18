import { useEffect, useCallback, useState, useRef } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import { useVoice } from '../../context/VoiceContext';
import { useChat } from '../../context/ChatContext';
import { useExperts } from '../../context/ExpertContext';
import { useAudioCapture } from '../../hooks/useAudioCapture';
import { useAudioPlayback } from '../../hooks/useAudioPlayback';
import ExpertAvatar from './call/ExpertAvatar';
import SubtitleBar from './call/SubtitleBar';
import WaveformVisualizer from './call/WaveformVisualizer';
import CallControls from './call/CallControls';
import ModelSetupView from './call/ModelSetupView';

const STATE_LABELS: Record<string, string> = {
  idle: '',
  initializing: '',
  listening: 'Hold Space or press the mic to talk',
  processing: 'Thinking...',
  speaking: 'Speaking...',
};

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export default function CallScreen() {
  const {
    sessionState,
    activeSession,
    currentTranscription,
    currentResponse,
    isSpeaking,
    subtitlesEnabled,
    callError,
    statusMessage,
    endCall,
    startSpeaking,
    stopSpeaking,
    toggleSubtitles,
  } = useVoice();

  const { setActiveScreen } = useChat();
  const { experts } = useExperts();
  const [callDuration, setCallDuration] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const expert = activeSession
    ? experts.find((e) => e.id === activeSession.expertId)
    : null;

  // Audio capture → send chunks to main process
  const onAudioChunk = useCallback(
    (chunk: ArrayBuffer) => {
      if (activeSession) {
        window.cerebro.voice.sendAudioChunk(activeSession.sessionId, chunk);
      }
    },
    [activeSession],
  );

  const {
    start: startCapture,
    stop: stopCapture,
    setMuted,
    analyserNode: micAnalyser,
    error: micError,
  } = useAudioCapture(onAudioChunk);

  // Mute mic when NOT speaking (PTT not held)
  useEffect(() => {
    setMuted(!isSpeaking);
  }, [isSpeaking, setMuted]);

  const {
    playChunk,
    stop: stopPlayback,
    isPlaying,
    analyserNode: speakerAnalyser,
  } = useAudioPlayback();

  // Start mic capture when call is active (always running for waveform)
  useEffect(() => {
    if (sessionState === 'listening' || sessionState === 'speaking' || sessionState === 'processing') {
      startCapture();
    }
  }, [sessionState, startCapture]);

  // Listen for TTS audio events and play them
  useEffect(() => {
    if (!activeSession) return;

    const unsubscribe = window.cerebro.voice.onEvent(
      activeSession.sessionId,
      (event) => {
        if (event.type === 'tts_audio') {
          playChunk(event.chunk);
        }
      },
    );

    return unsubscribe;
  }, [activeSession, playChunk]);

  // Call duration timer
  useEffect(() => {
    if (sessionState !== 'idle' && sessionState !== 'initializing') {
      timerRef.current = setInterval(() => {
        setCallDuration((prev) => prev + 1);
      }, 1000);
    } else {
      setCallDuration(0);
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [sessionState]);

  const handleEndCall = useCallback(() => {
    stopCapture();
    stopPlayback();
    endCall();
  }, [stopCapture, stopPlayback, endCall]);

  // Keyboard shortcuts: Space = PTT, Escape = end call
  const handleEndCallRef = useRef(handleEndCall);
  handleEndCallRef.current = handleEndCall;
  const startSpeakingRef = useRef(startSpeaking);
  startSpeakingRef.current = startSpeaking;
  const stopSpeakingRef = useRef(stopSpeaking);
  stopSpeakingRef.current = stopSpeaking;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        startSpeakingRef.current();
      }
      if (e.code === 'Escape') {
        handleEndCallRef.current();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        stopSpeakingRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // Select analyser: mic when speaking, speaker when expert plays, null otherwise
  const activeAnalyser = isSpeaking
    ? micAnalyser
    : sessionState === 'speaking' && isPlaying
      ? speakerAnalyser
      : null;

  // Show model-not-found view if models are missing
  if (callError && callError.includes('not found') && !activeSession) {
    return <ModelSetupView onBack={() => setActiveScreen('experts')} />;
  }

  // Determine status text
  const displayStatus = isSpeaking
    ? 'Recording...'
    : statusMessage || STATE_LABELS[sessionState] || '';

  return (
    <div className="flex-1 flex flex-col items-center justify-between py-8 px-6 animate-fade-in">
      {/* Top: timer and state */}
      <div className="flex flex-col items-center gap-1">
        <div className="flex items-center gap-4">
          {sessionState !== 'idle' && sessionState !== 'initializing' && (
            <span className="text-xs text-text-tertiary font-mono tabular-nums">
              {formatDuration(callDuration)}
            </span>
          )}
          {sessionState === 'initializing' && statusMessage ? (
            <span className="text-xs text-accent flex items-center gap-2">
              <Loader2 size={12} className="animate-spin" />
              {statusMessage}
            </span>
          ) : (
            <span className="text-xs text-text-secondary">
              {displayStatus}
            </span>
          )}
        </div>

        {/* Microphone error */}
        {micError && (
          <span className="text-xs text-red-400 mt-1">
            Microphone error: {micError}
          </span>
        )}

        {/* Call error (non-fatal, shown inline) */}
        {callError && activeSession && (
          <div className="flex items-center gap-1.5 mt-1">
            <AlertCircle size={12} className="text-red-400" />
            <span className="text-xs text-red-400">{callError}</span>
          </div>
        )}
      </div>

      {/* Center: avatar or error */}
      <div className="flex-1 flex items-center justify-center">
        {callError && !activeSession ? (
          <div className="flex flex-col items-center gap-4 text-center max-w-sm">
            <div className="w-16 h-16 rounded-full bg-red-500/15 flex items-center justify-center">
              <AlertCircle size={28} className="text-red-400" />
            </div>
            <div>
              <h3 className="text-base font-medium text-text-primary">
                Call Failed
              </h3>
              <p className="text-sm text-text-secondary mt-1">
                {callError}
              </p>
            </div>
            <button
              onClick={() => setActiveScreen('experts')}
              className="px-6 py-2 rounded-xl text-sm font-medium bg-bg-elevated hover:bg-bg-hover border border-border-subtle text-text-secondary transition-colors"
            >
              Go Back
            </button>
          </div>
        ) : (
          <ExpertAvatar
            domain={expert?.domain ?? null}
            name={expert?.name ?? 'Expert'}
            sessionState={sessionState}
            avatarUrl={expert?.avatarUrl ?? null}
            analyser={speakerAnalyser}
            isVerified={expert?.isVerified ?? false}
          />
        )}
      </div>

      {/* Subtitles */}
      {!callError && (
        <SubtitleBar
          sessionState={sessionState}
          transcription={currentTranscription}
          response={currentResponse}
          visible={subtitlesEnabled}
        />
      )}

      {/* Waveform */}
      {!callError && (
        <div className="my-4">
          <WaveformVisualizer analyserNode={activeAnalyser} />
        </div>
      )}

      {/* Controls */}
      <CallControls
        isSpeaking={isSpeaking}
        canSpeak={sessionState === 'listening' || sessionState === 'speaking'}
        subtitlesEnabled={subtitlesEnabled}
        onStartSpeaking={startSpeaking}
        onStopSpeaking={stopSpeaking}
        onEndCall={handleEndCall}
        onToggleSubtitles={toggleSubtitles}
      />
    </div>
  );
}
