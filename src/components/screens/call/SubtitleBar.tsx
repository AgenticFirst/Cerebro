import type { VoiceSessionState } from '../../../voice/types';

interface SubtitleBarProps {
  sessionState: VoiceSessionState;
  transcription: string;
  response: string;
  visible: boolean;
}

export default function SubtitleBar({
  sessionState,
  transcription,
  response,
  visible,
}: SubtitleBarProps) {
  if (!visible) return null;

  // Show user transcription when it arrives (state is 'processing' by then,
  // since silence detection transitions away from 'listening' before STT returns)
  const hasTranscription =
    (sessionState === 'listening' || sessionState === 'processing') && transcription;
  const isExpertSpeaking =
    (sessionState === 'speaking' || sessionState === 'processing') && response;

  // Prefer showing expert response when available, fall back to user transcription
  const text = isExpertSpeaking ? response : hasTranscription ? transcription : '';

  if (!text) return null;

  return (
    <div className="w-full max-w-2xl mx-auto px-4">
      <div
        className="bg-bg-elevated/80 backdrop-blur-sm border border-border-subtle rounded-xl px-5 py-3 animate-fade-in"
      >
        <p
          className={`text-sm leading-relaxed ${
            hasTranscription && !isExpertSpeaking
              ? 'text-text-tertiary italic'
              : 'text-text-primary'
          }`}
        >
          {hasTranscription && !isExpertSpeaking && (
            <span className="text-text-tertiary text-xs mr-2">You:</span>
          )}
          {text}
        </p>
      </div>
    </div>
  );
}
