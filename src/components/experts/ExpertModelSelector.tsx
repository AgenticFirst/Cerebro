/**
 * Model selector for expert detail panel.
 * Allows overriding the global model for a specific expert.
 */

import { useState, useEffect, useMemo } from 'react';
import type { Expert, ExpertModelConfig } from '../../context/ExpertContext';
import { useProviders } from '../../context/ProviderContext';
import { useModels } from '../../context/ModelContext';
import type { CloudProvider } from '../../types/providers';

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
  { provider: 'google', id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  { provider: 'google', id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
];

interface ExpertModelSelectorProps {
  expert: Expert;
  onUpdate: (id: string, fields: Record<string, unknown>) => Promise<void>;
}

export default function ExpertModelSelector({ expert, onUpdate }: ExpertModelSelectorProps) {
  const { enabledModels, connectionStatus } = useProviders();
  const { downloadedModels, engineStatus } = useModels();
  const [useOverride, setUseOverride] = useState(!!expert.modelConfigData);

  useEffect(() => {
    setUseOverride(!!expert.modelConfigData);
  }, [expert.id, expert.modelConfigData]);

  // Build list of available models
  const availableModels = useMemo(() => {
    const models: Array<{ key: string; label: string; source: 'local' | 'cloud'; provider?: CloudProvider; modelId: string }> = [];

    // Local downloaded models
    for (const m of downloadedModels) {
      models.push({
        key: `local::${m.id}`,
        label: `${m.name} (Local)`,
        source: 'local',
        modelId: m.id,
      });
    }

    // Cloud models
    const availableCloud = BUILTIN_CLOUD_MODELS.filter((m) => {
      const providerStatus = connectionStatus[m.provider];
      const hasKey = providerStatus && providerStatus.status !== 'not_configured';
      return enabledModels.has(m.id) && hasKey;
    });

    for (const m of availableCloud) {
      models.push({
        key: `cloud:${m.provider}:${m.id}`,
        label: m.name,
        source: 'cloud',
        provider: m.provider,
        modelId: m.id,
      });
    }

    return models;
  }, [downloadedModels, enabledModels, connectionStatus]);

  const handleToggle = (override: boolean) => {
    setUseOverride(override);
    if (!override) {
      onUpdate(expert.id, { model_config_data: null });
    }
  };

  const handleModelSelect = (key: string) => {
    const model = availableModels.find((m) => m.key === key);
    if (!model) return;
    const config: ExpertModelConfig = {
      source: model.source,
      provider: model.provider ?? null,
      model_id: model.modelId,
      display_name: model.label,
    };
    onUpdate(expert.id, { model_config_data: config });
  };

  const currentKey = expert.modelConfigData
    ? `${expert.modelConfigData.source}:${expert.modelConfigData.provider || ''}:${expert.modelConfigData.model_id}`
    : '';

  return (
    <div className="space-y-2.5">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="radio"
          name={`model-${expert.id}`}
          checked={!useOverride}
          onChange={() => handleToggle(false)}
          className="accent-[#06B6D4]"
        />
        <span className="text-xs text-text-secondary">Use global default</span>
      </label>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="radio"
          name={`model-${expert.id}`}
          checked={useOverride}
          onChange={() => handleToggle(true)}
          className="accent-[#06B6D4]"
        />
        <span className="text-xs text-text-secondary">Override for this expert</span>
      </label>

      {useOverride && (
        <select
          value={currentKey}
          onChange={(e) => handleModelSelect(e.target.value)}
          className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-accent/30 transition-colors"
        >
          <option value="">Select a model...</option>
          {availableModels.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
