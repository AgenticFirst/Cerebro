import { AlertTriangle } from 'lucide-react';

interface ModelSetupViewProps {
  onBack: () => void;
}

export default function ModelSetupView({ onBack }: ModelSetupViewProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 animate-fade-in">
      <div className="w-full max-w-md text-center space-y-6">
        <div className="w-16 h-16 rounded-full bg-amber-500/15 flex items-center justify-center mx-auto">
          <AlertTriangle size={28} className="text-amber-400" />
        </div>

        <div>
          <h2 className="text-xl font-semibold text-text-primary">
            Voice Models Not Found
          </h2>
          <p className="text-sm text-text-secondary mt-3 leading-relaxed">
            Voice models are not installed. If you're running from source, run the
            download script first:
          </p>
          <pre className="mt-3 bg-bg-base border border-border-subtle rounded-lg px-4 py-2.5 text-xs text-accent font-mono text-left">
            python scripts/download-voice-models.py
          </pre>
          <p className="text-xs text-text-tertiary mt-3">
            This downloads the Kokoro TTS model (~340 MB) to the voice-models/
            directory. Whisper STT auto-downloads on first use. Production
            builds bundle these automatically.
          </p>
        </div>

        <button
          onClick={onBack}
          className="px-6 py-2 rounded-xl text-sm font-medium bg-bg-elevated hover:bg-bg-hover border border-border-subtle text-text-secondary transition-colors"
        >
          Go Back
        </button>
      </div>
    </div>
  );
}
