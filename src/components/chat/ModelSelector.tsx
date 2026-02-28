import { useState, useRef, useEffect } from 'react';
import { ChevronUp, Check, Loader2, Settings2 } from 'lucide-react';
import clsx from 'clsx';
import { useModels } from '../../context/ModelContext';
import { useChat } from '../../context/ChatContext';

const TIER_DOT: Record<string, string> = {
  starter: 'bg-emerald-400',
  balanced: 'bg-blue-400',
  power: 'bg-purple-400',
};

export default function ModelSelector() {
  const { downloadedModels, activeModel, engineStatus, loadModel } = useModels();
  const { setActiveScreen } = useChat();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClick);
      return () => document.removeEventListener('mousedown', handleClick);
    }
  }, [open]);

  const isLoading = engineStatus.state === 'loading';
  const hasDownloaded = downloadedModels.length > 0;

  // No models downloaded — show setup link
  if (!hasDownloaded) {
    return (
      <button
        onClick={() => setActiveScreen('integrations')}
        className="text-xs text-accent hover:text-accent-hover transition-colors cursor-pointer whitespace-nowrap"
      >
        Set up a model →
      </button>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={clsx(
          'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors cursor-pointer',
          'hover:bg-bg-hover',
          activeModel ? 'text-text-secondary' : 'text-text-tertiary',
        )}
      >
        {isLoading ? (
          <Loader2 size={10} className="animate-spin" />
        ) : activeModel ? (
          <div className={clsx('w-1.5 h-1.5 rounded-full', TIER_DOT[activeModel.tier] ?? 'bg-accent')} />
        ) : (
          <div className="w-1.5 h-1.5 rounded-full bg-text-tertiary" />
        )}
        <span className="max-w-[120px] truncate">
          {isLoading
            ? 'Loading...'
            : activeModel
              ? activeModel.name
              : 'No model loaded'}
        </span>
        <ChevronUp
          size={10}
          className={clsx('transition-transform', open ? 'rotate-0' : 'rotate-180')}
        />
      </button>

      {/* Dropdown (opens upward) */}
      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-56 bg-bg-elevated border border-border-subtle rounded-lg shadow-xl py-1 z-50">
          {downloadedModels.map((model) => {
            const isActive = model.id === engineStatus.loaded_model_id;
            return (
              <button
                key={model.id}
                onClick={async () => {
                  if (!isActive) {
                    await loadModel(model.id);
                  }
                  setOpen(false);
                }}
                className={clsx(
                  'w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-colors cursor-pointer',
                  isActive
                    ? 'text-text-primary bg-accent/5'
                    : 'text-text-secondary hover:bg-bg-hover',
                )}
              >
                <div className={clsx('w-1.5 h-1.5 rounded-full flex-shrink-0', TIER_DOT[model.tier] ?? 'bg-accent')} />
                <span className="flex-1 truncate">{model.name}</span>
                {isActive && <Check size={12} className="text-accent flex-shrink-0" />}
              </button>
            );
          })}

          <div className="border-t border-border-subtle my-1" />
          <button
            onClick={() => {
              setActiveScreen('integrations');
              setOpen(false);
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            <Settings2 size={12} />
            Manage models
          </button>
        </div>
      )}
    </div>
  );
}
