import { Mic, PhoneOff, Subtitles } from 'lucide-react';
import clsx from 'clsx';

interface CallControlsProps {
  isSpeaking: boolean;
  canSpeak: boolean;
  subtitlesEnabled: boolean;
  onStartSpeaking: () => void;
  onStopSpeaking: () => void;
  onEndCall: () => void;
  onToggleSubtitles: () => void;
}

export default function CallControls({
  isSpeaking,
  canSpeak,
  subtitlesEnabled,
  onStartSpeaking,
  onStopSpeaking,
  onEndCall,
  onToggleSubtitles,
}: CallControlsProps) {
  return (
    <div className="flex items-center gap-4">
      {/* Push-to-talk button */}
      <button
        onPointerDown={(e) => {
          e.preventDefault();
          if (canSpeak) onStartSpeaking();
        }}
        onPointerUp={(e) => {
          e.preventDefault();
          if (isSpeaking) onStopSpeaking();
        }}
        onPointerLeave={() => {
          if (isSpeaking) onStopSpeaking();
        }}
        disabled={!canSpeak}
        className={clsx(
          'w-14 h-14 rounded-full flex items-center justify-center transition-all duration-200 select-none',
          isSpeaking
            ? 'bg-accent/30 border-2 border-accent text-accent scale-110 shadow-lg shadow-accent/20'
            : canSpeak
              ? 'bg-bg-elevated border border-border-default text-text-secondary hover:text-text-primary hover:border-border-accent cursor-pointer'
              : 'bg-bg-elevated/50 border border-border-subtle text-text-tertiary cursor-not-allowed opacity-50',
        )}
        title="Hold to talk (Space)"
      >
        <Mic size={22} />
      </button>

      {/* End call button */}
      <button
        onClick={onEndCall}
        className="w-14 h-14 rounded-full flex items-center justify-center bg-red-600 hover:bg-red-500 text-white transition-colors duration-200 shadow-lg shadow-red-900/30"
        title="End Call (Esc)"
      >
        <PhoneOff size={22} />
      </button>

      {/* Subtitles toggle */}
      <button
        onClick={onToggleSubtitles}
        className={clsx(
          'w-12 h-12 rounded-full flex items-center justify-center transition-colors duration-200',
          subtitlesEnabled
            ? 'bg-accent/20 border border-accent/40 text-accent'
            : 'bg-bg-elevated border border-border-default text-text-tertiary hover:text-text-secondary',
        )}
        title={subtitlesEnabled ? 'Hide captions' : 'Show captions'}
      >
        <Subtitles size={20} />
      </button>
    </div>
  );
}
