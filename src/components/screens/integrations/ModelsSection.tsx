import { useState, type ComponentType } from 'react';
import { Eye, EyeOff, Shield, HardDrive } from 'lucide-react';
import clsx from 'clsx';
import { AnthropicIcon, OpenAIIcon, GoogleIcon } from '../../icons/BrandIcons';

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
    models: [
      { id: 'gemini-2-5-pro', name: 'Gemini 2.5 Pro', context: '1M', enabled: true },
      { id: 'gemini-2-0-flash', name: 'Gemini 2.0 Flash', context: '1M', enabled: false },
    ],
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

  const hasKey = apiKey.length > 0;
  const Icon = provider.icon;

  const toggleModel = (modelId: string) => {
    setModels((prev) =>
      prev.map((m) => (m.id === modelId ? { ...m, enabled: !m.enabled } : m)),
    );
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
              hasKey ? 'bg-emerald-400' : 'bg-text-tertiary',
            )}
          />
          <span className={clsx('text-xs', hasKey ? 'text-emerald-400' : 'text-text-tertiary')}>
            {hasKey ? 'Connected' : 'Not configured'}
          </span>
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
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={provider.placeholder}
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
            className={clsx(
              'px-3 py-2 rounded-md text-xs font-medium transition-colors',
              hasKey
                ? 'bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 cursor-pointer'
                : 'bg-bg-elevated text-text-tertiary border border-border-subtle cursor-not-allowed',
            )}
            disabled={!hasKey}
          >
            Verify
          </button>
        </div>
      </div>

      {/* Models */}
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
      <div className="mt-8">
        <h3 className="text-sm font-medium text-text-primary mb-3">Local Models</h3>
        <div className="border-2 border-dashed border-border-default rounded-xl py-8 px-6 flex flex-col items-center text-center">
          <div className="w-10 h-10 rounded-xl bg-bg-elevated border border-border-subtle flex items-center justify-center mb-3">
            <HardDrive size={16} className="text-text-tertiary" />
          </div>
          <span className="text-xs font-medium text-text-tertiary uppercase tracking-wide mb-1.5">
            Coming Soon
          </span>
          <p className="text-xs text-text-tertiary max-w-sm leading-relaxed">
            Download and run models locally with Ollama, llama.cpp, and other local inference
            engines.
          </p>
        </div>
      </div>

      {/* Security Note */}
      <div className="mt-6 flex items-start gap-3 px-4 py-3 rounded-lg bg-accent/[0.06] border border-accent/10">
        <Shield size={16} className="text-accent flex-shrink-0 mt-0.5" />
        <p className="text-xs text-text-secondary leading-relaxed">
          API keys are stored locally on your device and never transmitted to external servers.
        </p>
      </div>
    </div>
  );
}
