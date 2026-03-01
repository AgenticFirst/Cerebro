import { useState, useRef, useEffect, useMemo } from 'react';
import { ChevronUp, Check, Loader2, Settings2 } from 'lucide-react';
import clsx from 'clsx';
import { useModels } from '../../context/ModelContext';
import { useProviders } from '../../context/ProviderContext';
import { useChat } from '../../context/ChatContext';
import type { CloudProvider } from '../../types/providers';

const TIER_DOT: Record<string, string> = {
  starter: 'bg-emerald-400',
  balanced: 'bg-blue-400',
  power: 'bg-purple-400',
};

// Provider brand colors for cloud model dots
const PROVIDER_DOT: Record<string, string> = {
  anthropic: 'bg-amber-400',
  openai: 'bg-emerald-400',
  google: 'bg-blue-400',
};

interface CloudModelEntry {
  provider: CloudProvider;
  id: string;
  name: string;
}

const BUILTIN_CLOUD_MODELS: CloudModelEntry[] = [
  { provider: 'anthropic', id: 'claude-opus-4', name: 'Claude Opus 4' },
  { provider: 'anthropic', id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
  { provider: 'anthropic', id: 'claude-haiku-3-5', name: 'Claude Haiku 3.5' },
  { provider: 'openai', id: 'gpt-4.1', name: 'GPT-4.1' },
  { provider: 'openai', id: 'gpt-4.1-mini', name: 'GPT-4.1 mini' },
  { provider: 'openai', id: 'gpt-4.1-nano', name: 'GPT-4.1 nano' },
  { provider: 'openai', id: 'o4-mini', name: 'o4-mini' },
  { provider: 'google', id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  { provider: 'google', id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
];

export default function ModelSelector() {
  const { downloadedModels, engineStatus, loadModel } = useModels();
  const { selectedModel, selectModel, enabledModels, connectionStatus, customModels } =
    useProviders();
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

  // Merge builtin + custom models, dedup by id
  const allCloudModels = useMemo(() => {
    const builtinIds = new Set(BUILTIN_CLOUD_MODELS.map((m) => m.id));
    const customs = customModels
      .filter((m) => !builtinIds.has(m.id))
      .map((m) => ({ provider: m.provider, id: m.id, name: m.name }));
    return [...BUILTIN_CLOUD_MODELS, ...customs];
  }, [customModels]);

  // Available cloud models: enabled AND provider has a key
  const availableCloudModels = allCloudModels.filter((m) => {
    const providerStatus = connectionStatus[m.provider];
    const hasKey = providerStatus && providerStatus.status !== 'not_configured';
    return enabledModels.has(m.id) && hasKey;
  });

  const hasAnyModel = hasDownloaded || availableCloudModels.length > 0;

  // No models available at all — show setup link
  if (!hasAnyModel) {
    return (
      <button
        onClick={() => setActiveScreen('integrations')}
        className="text-xs text-accent hover:text-accent-hover transition-colors cursor-pointer whitespace-nowrap"
      >
        Set up a model →
      </button>
    );
  }

  // Determine pill display
  const pillLabel = selectedModel
    ? selectedModel.displayName
    : isLoading
      ? 'Loading...'
      : 'Select model';

  const pillDot = selectedModel
    ? selectedModel.source === 'cloud'
      ? PROVIDER_DOT[selectedModel.provider ?? ''] ?? 'bg-accent'
      : TIER_DOT[
          downloadedModels.find((m) => m.id === selectedModel.modelId)?.tier ?? ''
        ] ?? 'bg-accent'
    : 'bg-text-tertiary';

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={clsx(
          'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors cursor-pointer',
          'hover:bg-bg-hover',
          selectedModel ? 'text-text-secondary' : 'text-text-tertiary',
        )}
      >
        {isLoading ? (
          <Loader2 size={10} className="animate-spin" />
        ) : (
          <div className={clsx('w-1.5 h-1.5 rounded-full', pillDot)} />
        )}
        <span className="max-w-[140px] truncate">{pillLabel}</span>
        <ChevronUp
          size={10}
          className={clsx('transition-transform', open ? 'rotate-0' : 'rotate-180')}
        />
      </button>

      {/* Dropdown (opens upward) */}
      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-60 bg-bg-elevated border border-border-subtle rounded-lg shadow-xl py-1 z-50 max-h-80 overflow-y-auto">
          {/* Cloud Models */}
          {availableCloudModels.length > 0 && (
            <>
              <div className="px-3 py-1.5 text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
                Cloud Models
              </div>
              {availableCloudModels.map((model) => {
                const isActive =
                  selectedModel?.source === 'cloud' && selectedModel.modelId === model.id;
                return (
                  <button
                    key={model.id}
                    onClick={() => {
                      selectModel({
                        source: 'cloud',
                        provider: model.provider,
                        modelId: model.id,
                        displayName: model.name,
                      });
                      setOpen(false);
                    }}
                    className={clsx(
                      'w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-colors cursor-pointer',
                      isActive
                        ? 'text-text-primary bg-accent/5'
                        : 'text-text-secondary hover:bg-bg-hover',
                    )}
                  >
                    <div
                      className={clsx(
                        'w-1.5 h-1.5 rounded-full flex-shrink-0',
                        PROVIDER_DOT[model.provider],
                      )}
                    />
                    <span className="flex-1 truncate">{model.name}</span>
                    {isActive && <Check size={12} className="text-accent flex-shrink-0" />}
                  </button>
                );
              })}
            </>
          )}

          {/* Local Models */}
          {hasDownloaded && (
            <>
              {availableCloudModels.length > 0 && (
                <div className="border-t border-border-subtle my-1" />
              )}
              <div className="px-3 py-1.5 text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
                Local Models
              </div>
              {downloadedModels.map((model) => {
                const isActive =
                  selectedModel?.source === 'local' && selectedModel.modelId === model.id;
                return (
                  <button
                    key={model.id}
                    onClick={async () => {
                      selectModel({
                        source: 'local',
                        modelId: model.id,
                        displayName: model.name,
                      });
                      // Load the local model if not already loaded
                      if (engineStatus.loaded_model_id !== model.id) {
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
                    <div
                      className={clsx(
                        'w-1.5 h-1.5 rounded-full flex-shrink-0',
                        TIER_DOT[model.tier] ?? 'bg-accent',
                      )}
                    />
                    <span className="flex-1 truncate">{model.name}</span>
                    {isActive && <Check size={12} className="text-accent flex-shrink-0" />}
                  </button>
                );
              })}
            </>
          )}

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
