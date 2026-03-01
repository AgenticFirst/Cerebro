import { useState, useEffect, type ComponentType } from 'react';
import { Eye, EyeOff, Shield, Cpu, Info } from 'lucide-react';
import clsx from 'clsx';
import { AnthropicIcon, OpenAIIcon, GoogleIcon, HuggingFaceIcon } from '../../icons/BrandIcons';
import { useModels } from '../../../context/ModelContext';
import LocalModelCard from './LocalModelCard';

interface Model {
  id: string;
  name: string;
  context: string;
  enabled: boolean;
}

interface Provider {
  id: string;
  name: string;
  subtitle: string;
  color: string;
  textColor: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  placeholder: string;
  keyPrefix: string;
  models: Model[];
}

const PROVIDERS: Provider[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    subtitle: 'Claude models',
    color: 'bg-amber-500/15',
    textColor: 'text-amber-400',
    icon: AnthropicIcon,
    placeholder: 'sk-ant-api03-...',
    keyPrefix: 'sk-ant-',
    models: [
      { id: 'claude-opus-4', name: 'Claude Opus 4', context: '200K', enabled: true },
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', context: '200K', enabled: true },
      { id: 'claude-haiku-3-5', name: 'Claude Haiku 3.5', context: '200K', enabled: false },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    subtitle: 'GPT & o-series models',
    color: 'bg-emerald-500/15',
    textColor: 'text-emerald-400',
    icon: OpenAIIcon,
    placeholder: 'sk-proj-...',
    keyPrefix: 'sk-',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', context: '128K', enabled: true },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', context: '128K', enabled: false },
      { id: 'o1', name: 'o1', context: '200K', enabled: false },
    ],
  },
  {
    id: 'google',
    name: 'Google',
    subtitle: 'Gemini models',
    color: 'bg-blue-500/15',
    textColor: 'text-blue-400',
    icon: GoogleIcon,
    placeholder: 'AIza...',
    keyPrefix: 'AIza',
    models: [
      { id: 'gemini-2-5-pro', name: 'Gemini 2.5 Pro', context: '1M', enabled: true },
      { id: 'gemini-2-0-flash', name: 'Gemini 2.0 Flash', context: '1M', enabled: false },
    ],
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    subtitle: 'Model downloads',
    color: 'bg-yellow-500/15',
    textColor: 'text-yellow-400',
    icon: HuggingFaceIcon,
    placeholder: 'hf_...',
    keyPrefix: 'hf_',
    models: [],
  },
];

function Toggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={clsx(
        'relative w-8 h-[18px] rounded-full transition-colors duration-200 cursor-pointer flex-shrink-0',
        enabled ? 'bg-accent' : 'bg-bg-hover',
      )}
    >
      <div
        className={clsx(
          'absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-transform duration-200 shadow-sm',
          enabled ? 'translate-x-[16px]' : 'translate-x-[2px]',
        )}
      />
    </button>
  );
}

function ProviderCard({ provider }: { provider: Provider }) {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState(provider.models);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');

  const Icon = provider.icon;
  const inputHasValue = apiKey.length > 0;

  useEffect(() => {
    window.cerebro.credentials.has(provider.id, 'api_key').then(setSaved);
  }, [provider.id]);

  const handleSave = async () => {
    setError('');
    setWarning('');

    if (!apiKey.startsWith(provider.keyPrefix)) {
      setWarning(`Key doesn't start with expected prefix "${provider.keyPrefix}" — saving anyway`);
    }

    setSaving(true);
    const result = await window.cerebro.credentials.set({
      service: provider.id,
      key: 'api_key',
      value: apiKey,
      label: `${provider.name} API Key`,
    });
    setSaving(false);

    if (result.ok) {
      setSaved(true);
      setApiKey('');
    } else {
      setError(result.error ?? 'Failed to save credential');
    }
  };

  const handleRemove = async () => {
    const result = await window.cerebro.credentials.delete(provider.id, 'api_key');
    if (result.ok) {
      setSaved(false);
      setWarning('');
    }
  };

  const toggleModel = (modelId: string) => {
    setModels((prev) => prev.map((m) => (m.id === modelId ? { ...m, enabled: !m.enabled } : m)));
  };

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3.5">
        <div
          className={clsx(
            'w-8 h-8 rounded-lg flex items-center justify-center',
            provider.color,
            provider.textColor,
          )}
        >
          <Icon size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-text-primary">{provider.name}</div>
          <div className="text-xs text-text-tertiary">{provider.subtitle}</div>
        </div>
        <div className="flex items-center gap-1.5">
          <div
            className={clsx(
              'w-1.5 h-1.5 rounded-full',
              saved ? 'bg-emerald-400' : 'bg-text-tertiary',
            )}
          />
          <span className={clsx('text-xs', saved ? 'text-emerald-400' : 'text-text-tertiary')}>
            {saved ? 'Connected' : 'Not configured'}
          </span>
          {saved && (
            <button
              onClick={handleRemove}
              className="text-xs text-text-tertiary hover:text-red-400 transition-colors cursor-pointer ml-2"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      <div className="border-t border-border-subtle" />

      {/* API Key */}
      <div className="px-4 py-3.5">
        <label className="text-xs font-medium text-text-secondary mb-2 block">API Key</label>
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setError('');
              }}
              placeholder={
                saved ? 'Key saved securely \u2014 enter new key to replace' : provider.placeholder
              }
              className="w-full bg-bg-base border border-border-default rounded-md px-3 py-2 text-sm font-mono text-text-primary placeholder:text-text-tertiary/50 focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 transition-colors"
            />
            <button
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer p-0.5"
            >
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <button
            onClick={handleSave}
            className={clsx(
              'px-3 py-2 rounded-md text-xs font-medium transition-colors',
              inputHasValue && !saving
                ? 'bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 cursor-pointer'
                : 'bg-bg-elevated text-text-tertiary border border-border-subtle cursor-not-allowed',
            )}
            disabled={!inputHasValue || saving}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
        {warning && <p className="text-xs text-amber-400 mt-1.5">{warning}</p>}
        {error && <p className="text-xs text-red-400 mt-1.5">{error}</p>}
      </div>

      {/* Models or info note */}
      {provider.models.length > 0 ? (
        <div className="px-4 pb-3.5">
          <label className="text-xs font-medium text-text-secondary mb-2 block">Models</label>
          <div className="space-y-px">
            {models.map((model) => (
              <div
                key={model.id}
                className="flex items-center justify-between py-2 px-3 rounded-md hover:bg-white/[0.02] transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="text-sm text-text-primary">{model.name}</span>
                  <span className="text-[10px] font-medium text-text-tertiary bg-bg-elevated px-1.5 py-0.5 rounded">
                    {model.context}
                  </span>
                </div>
                <Toggle enabled={model.enabled} onToggle={() => toggleModel(model.id)} />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="px-4 pb-3.5">
          <div className="flex items-start gap-2 px-3 py-2.5 rounded-md bg-white/[0.02]">
            <Info size={14} className="text-text-tertiary flex-shrink-0 mt-0.5" />
            <p className="text-xs text-text-tertiary leading-relaxed">
              Token enables authenticated downloads with faster speeds and higher rate limits for
              supported local models.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function formatDiskSpace(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(0)} GB`;
}

function LocalModelsSection() {
  const {
    catalog,
    engineStatus,
    activeDownloads,
    diskSpace,
    hardware,
    recommendedModelId,
    isLoading,
    downloadModel,
    cancelDownload,
    deleteModel,
    loadModel,
    unloadModel,
  } = useModels();

  return (
    <div className="mt-8">
      <div className="flex items-center gap-2 mb-1">
        <Cpu size={16} className="text-accent" />
        <h3 className="text-sm font-medium text-text-primary">Local Models</h3>
      </div>
      <p className="text-xs text-text-tertiary mb-4">
        Download and run models directly on your machine. No API key required.
      </p>

      {/* Hardware recommendation banner */}
      {hardware && !isLoading && (
        <div className="mb-4 px-3 py-2.5 rounded-lg bg-accent/[0.06] border border-accent/10">
          <p className="text-xs text-text-secondary leading-relaxed">
            Your machine has{' '}
            <span className="font-medium text-text-primary">{hardware.total_ram_gb} GB RAM</span>
            {hardware.gpu_name && (
              <>
                {' '}
                with <span className="font-medium text-text-primary">{hardware.gpu_name}</span>
              </>
            )}
            {recommendedModelId && (
              <>
                {' '}
                — we recommend{' '}
                <span className="font-medium text-accent">
                  {catalog.find((m) => m.id === recommendedModelId)?.name ?? recommendedModelId}
                </span>{' '}
                for the best experience
              </>
            )}
            .
          </p>
        </div>
      )}

      {/* Model cards */}
      <div className="space-y-3">
        {catalog.map((model) => (
          <LocalModelCard
            key={model.id}
            model={model}
            engineStatus={engineStatus}
            downloadProgress={activeDownloads.get(model.id)}
            diskSpace={diskSpace}
            isRecommended={model.id === recommendedModelId}
            onDownload={downloadModel}
            onCancelDownload={cancelDownload}
            onDelete={deleteModel}
            onLoad={loadModel}
            onUnload={unloadModel}
          />
        ))}
      </div>

      {/* Disk space indicator */}
      {diskSpace && (
        <p className="text-xs text-text-tertiary mt-3">
          Disk Space: {formatDiskSpace(diskSpace.free)} free of {formatDiskSpace(diskSpace.total)}
        </p>
      )}
    </div>
  );
}

export default function ModelsSection() {
  return (
    <div>
      <h2 className="text-lg font-medium text-text-primary">Models</h2>
      <p className="text-sm text-text-secondary mt-1 leading-relaxed">
        Connect cloud providers or download models to run locally.
      </p>

      {/* Cloud Providers */}
      <div className="mt-6 space-y-3">
        {PROVIDERS.map((provider) => (
          <ProviderCard key={provider.id} provider={provider} />
        ))}
      </div>

      {/* Local Models */}
      <LocalModelsSection />

      {/* Security Note */}
      <div className="mt-6 flex items-start gap-3 px-4 py-3 rounded-lg bg-accent/[0.06] border border-accent/10">
        <Shield size={16} className="text-accent flex-shrink-0 mt-0.5" />
        <p className="text-xs text-text-secondary leading-relaxed">
          API keys are encrypted using your OS keychain and stored locally. They are never
          transmitted to external servers.
        </p>
      </div>
    </div>
  );
}
