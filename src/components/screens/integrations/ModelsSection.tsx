import { useState, useEffect, useCallback, type ComponentType } from 'react';
import { Eye, EyeOff, Shield, Cpu, Info, Plus, ExternalLink, HelpCircle, KeyRound } from 'lucide-react';
import clsx from 'clsx';
import { AnthropicIcon, OpenAIIcon, GoogleIcon, HuggingFaceIcon } from '../../icons/BrandIcons';
import { useModels } from '../../../context/ModelContext';
import { useProviders } from '../../../context/ProviderContext';
import type { CloudProvider, ConnectionStatus } from '../../../types/providers';
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
  docsUrl?: string;
  modelIdHint?: string;
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
    docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models',
    modelIdHint: 'e.g. claude-opus-4, claude-sonnet-4-5',
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
    docsUrl: 'https://developers.openai.com/api/docs/models',
    modelIdHint: 'e.g. gpt-4.1, gpt-4.1-mini, o4-mini',
    models: [
      { id: 'gpt-4.1', name: 'GPT-4.1', context: '1M', enabled: true },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini', context: '1M', enabled: true },
      { id: 'gpt-4.1-nano', name: 'GPT-4.1 nano', context: '1M', enabled: false },
      { id: 'o4-mini', name: 'o4-mini', context: '200K', enabled: false },
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
    docsUrl: 'https://ai.google.dev/gemini-api/docs/models',
    modelIdHint: 'e.g. gemini-2.5-pro, gemini-2.0-flash',
    models: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', context: '1M', enabled: true },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', context: '1M', enabled: false },
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

// ── Connection status badge ──────────────────────────────────────

function ConnectionBadge({
  status,
  error,
}: {
  status: ConnectionStatus;
  error?: string;
}) {
  const config: Record<
    ConnectionStatus,
    { dot: string; label: string; labelColor: string; pulse?: boolean }
  > = {
    not_configured: {
      dot: 'bg-text-tertiary',
      label: 'Not configured',
      labelColor: 'text-text-tertiary',
    },
    key_saved: {
      dot: 'bg-amber-400',
      label: 'Key saved',
      labelColor: 'text-amber-400',
    },
    verifying: {
      dot: 'bg-amber-400',
      label: 'Verifying...',
      labelColor: 'text-amber-400',
      pulse: true,
    },
    connected: {
      dot: 'bg-emerald-400',
      label: 'Connected',
      labelColor: 'text-emerald-400',
    },
    error: {
      dot: 'bg-red-400',
      label: 'Error',
      labelColor: 'text-red-400',
    },
  };

  const c = config[status];

  return (
    <div className="flex items-center gap-1.5" title={status === 'error' && error ? error : undefined}>
      <div
        className={clsx('w-1.5 h-1.5 rounded-full', c.dot, c.pulse && 'animate-pulse')}
      />
      <span className={clsx('text-xs', c.labelColor)}>{c.label}</span>
    </div>
  );
}

function ApiKeyAlert({
  providerName,
  onClose,
}: {
  providerName: string;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Dialog */}
      <div className="relative bg-bg-surface border border-border-subtle rounded-xl shadow-2xl w-full max-w-sm mx-4 animate-fade-in">
        <div className="px-5 pt-5 pb-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center">
              <KeyRound size={18} className="text-accent" />
            </div>
            <h3 className="text-sm font-medium text-text-primary">API key required</h3>
          </div>
          <p className="text-xs text-text-secondary leading-relaxed">
            To enable models from {providerName}, add your API key in the field above first.
            Your key is stored securely in your OS keychain and never leaves your machine.
          </p>
        </div>
        <div className="border-t border-border-subtle px-5 py-3 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-md text-xs font-medium bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors cursor-pointer"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

function ProviderCard({ provider }: { provider: Provider }) {
  const {
    enabledModels,
    toggleModel,
    connectionStatus,
    verifyConnection,
    refreshConnectionStatus,
    setProviderStatus,
    customModels,
    addCustomModel,
    removeCustomModel,
  } = useProviders();
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [customModelId, setCustomModelId] = useState('');
  const [showKeyAlert, setShowKeyAlert] = useState(false);

  const Icon = provider.icon;
  const inputHasValue = apiKey.length > 0;
  const isCloudProvider = provider.id !== 'huggingface';

  // Connection state from provider context
  const providerConnection = connectionStatus[provider.id] ?? { status: 'not_configured' as ConnectionStatus };
  const isVerifying = providerConnection.status === 'verifying';
  const hasKey = providerConnection.status !== 'not_configured';

  // Guard: require API key before enabling models
  const requireKey = useCallback(
    (action: () => void) => {
      if (!hasKey) {
        setShowKeyAlert(true);
        return;
      }
      action();
    },
    [hasKey],
  );

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
      // Immediately set status to key_saved
      if (isCloudProvider) {
        setProviderStatus(provider.id, { status: 'key_saved' });
      }
    } else {
      setError(result.error ?? 'Failed to save credential');
    }
  };

  const handleRemove = async () => {
    const result = await window.cerebro.credentials.delete(provider.id, 'api_key');
    if (result.ok) {
      setSaved(false);
      setWarning('');
      // Immediately set status to not_configured (don't wait for async backend propagation)
      if (isCloudProvider) {
        setProviderStatus(provider.id, { status: 'not_configured' });
      }
    }
  };

  const handleTest = () => {
    if (isCloudProvider) {
      verifyConnection(provider.id as CloudProvider);
    }
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
          {isCloudProvider ? (
            <ConnectionBadge
              status={providerConnection.status}
              error={providerConnection.error}
            />
          ) : (
            <>
              <div
                className={clsx(
                  'w-1.5 h-1.5 rounded-full',
                  saved ? 'bg-emerald-400' : 'bg-text-tertiary',
                )}
              />
              <span className={clsx('text-xs', saved ? 'text-emerald-400' : 'text-text-tertiary')}>
                {saved ? 'Connected' : 'Not configured'}
              </span>
            </>
          )}
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
          {isCloudProvider && saved && (
            <button
              onClick={handleTest}
              disabled={isVerifying}
              className={clsx(
                'px-3 py-2 rounded-md text-xs font-medium transition-colors border',
                isVerifying
                  ? 'bg-bg-elevated text-text-tertiary border-border-subtle cursor-not-allowed'
                  : 'bg-bg-elevated text-text-secondary hover:text-text-primary hover:bg-bg-hover border-border-subtle cursor-pointer',
              )}
            >
              {isVerifying ? 'Testing...' : 'Test'}
            </button>
          )}
        </div>
        {warning && <p className="text-xs text-amber-400 mt-1.5">{warning}</p>}
        {error && <p className="text-xs text-red-400 mt-1.5">{error}</p>}
        {providerConnection.status === 'error' && providerConnection.error && (
          <p className="text-xs text-red-400 mt-1.5">{providerConnection.error}</p>
        )}
      </div>

      {/* Models or info note */}
      {provider.models.length > 0 ? (
        <div className="px-4 pb-3.5">
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-medium text-text-secondary">Models</label>
            {provider.docsUrl && (
              <a
                href={provider.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-accent transition-colors"
              >
                View all models <ExternalLink size={9} />
              </a>
            )}
          </div>
          <div className="space-y-px">
            {provider.models.map((model) => (
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
                <Toggle
                  enabled={enabledModels.has(model.id)}
                  onToggle={() => requireKey(() => toggleModel(model.id, !enabledModels.has(model.id)))}
                />
              </div>
            ))}
            {/* Custom models for this provider */}
            {customModels
              .filter((m) => m.provider === provider.id)
              .map((model) => (
                <div
                  key={model.id}
                  className="flex items-center justify-between py-2 px-3 rounded-md hover:bg-white/[0.02] transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-text-primary font-mono">{model.id}</span>
                    <span className="text-[10px] font-medium text-text-tertiary bg-bg-elevated px-1.5 py-0.5 rounded">
                      custom
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Toggle
                      enabled={enabledModels.has(model.id)}
                      onToggle={() => requireKey(() => toggleModel(model.id, !enabledModels.has(model.id)))}
                    />
                    <button
                      onClick={() => removeCustomModel(model.id)}
                      className="text-[10px] text-text-tertiary hover:text-red-400 transition-colors cursor-pointer"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
          </div>
          {/* Add custom model input */}
          <div className="mt-2 flex gap-2 items-center">
            <div className="flex-1 relative group">
              <input
                type="text"
                value={customModelId}
                onChange={(e) => setCustomModelId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customModelId.trim()) {
                    requireKey(() => {
                      addCustomModel(provider.id as CloudProvider, customModelId);
                      setCustomModelId('');
                    });
                  }
                }}
                placeholder={provider.modelIdHint ?? 'Enter model ID...'}
                className="w-full bg-bg-base border border-border-default rounded-md px-3 py-1.5 text-xs font-mono text-text-primary placeholder:text-text-tertiary/50 focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 transition-colors"
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 group-hover:opacity-100 opacity-50 transition-opacity">
                <div className="relative">
                  <HelpCircle size={12} className="text-text-tertiary cursor-help peer" />
                  <div className="absolute bottom-full right-0 mb-1.5 w-52 px-2.5 py-2 rounded-md bg-bg-elevated border border-border-subtle shadow-lg text-[10px] text-text-secondary leading-relaxed hidden peer-hover:block z-50">
                    Enter the exact model ID string from the provider's API docs. This is what gets
                    sent as the <span className="font-mono text-accent">model</span> parameter.
                  </div>
                </div>
              </div>
            </div>
            <button
              onClick={() => {
                if (customModelId.trim()) {
                  requireKey(() => {
                    addCustomModel(provider.id as CloudProvider, customModelId);
                    setCustomModelId('');
                  });
                }
              }}
              disabled={!customModelId.trim()}
              className={clsx(
                'p-1.5 rounded-md transition-colors',
                customModelId.trim()
                  ? 'text-accent hover:bg-accent/10 cursor-pointer'
                  : 'text-text-tertiary cursor-not-allowed',
              )}
            >
              <Plus size={14} />
            </button>
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

      {/* API key required modal */}
      {showKeyAlert && (
        <ApiKeyAlert
          providerName={provider.name}
          onClose={() => setShowKeyAlert(false)}
        />
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
