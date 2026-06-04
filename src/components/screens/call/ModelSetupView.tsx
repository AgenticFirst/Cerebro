import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ModelSetupViewProps {
  onBack: () => void;
}

export default function ModelSetupView({ onBack }: ModelSetupViewProps) {
  const { t } = useTranslation();
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 animate-fade-in">
      <div className="w-full max-w-md text-center space-y-6">
        <div className="w-16 h-16 rounded-full bg-amber-500/15 flex items-center justify-center mx-auto">
          <AlertTriangle size={28} className="text-amber-400" />
        </div>

        <div>
          <h2 className="text-xl font-semibold text-text-primary">{t('call.modelsNotFound')}</h2>
          <p className="text-sm text-text-secondary mt-3 leading-relaxed">
            {t('call.modelsNotInstalledPre')}
          </p>
          <pre className="mt-3 bg-bg-base border border-border-subtle rounded-lg px-4 py-2.5 text-xs text-accent font-mono text-left">
            python scripts/download-voice-models.py
          </pre>
          <p className="text-xs text-text-tertiary mt-3">{t('call.modelsNotInstalledPost')}</p>
        </div>

        <button
          onClick={onBack}
          className="px-6 py-2 rounded-xl text-sm font-medium bg-bg-elevated hover:bg-bg-hover border border-border-subtle text-text-secondary transition-colors"
        >
          {t('call.goBack')}
        </button>
      </div>
    </div>
  );
}
