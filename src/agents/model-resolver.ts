/**
 * Resolves which model an expert should use.
 *
 * Fallback hierarchy:
 * 1. Expert's own model_config (if set)
 * 2. Global selected model (from settings)
 * 3. Currently loaded local model (if any)
 */

import http from 'node:http';
import type { ResolvedModel, ExpertModelConfig } from './types';
import { getCachedClaudeCodeInfo } from '../claude-code/detector';

interface GlobalSettings {
  selected_model?: string; // JSON-encoded SelectedModel
}

export async function resolveModel(
  expertModelConfig: ExpertModelConfig | null | undefined,
  backendPort: number,
): Promise<ResolvedModel | null> {
  // 1. Expert's own model override
  if (expertModelConfig) {
    return {
      source: expertModelConfig.source,
      provider: expertModelConfig.provider ?? undefined,
      modelId: expertModelConfig.model_id,
      displayName: expertModelConfig.display_name,
    };
  }

  // 2. Global selected model from settings
  try {
    const settingsRes = await backendGet<{ key: string; value: string }>(
      backendPort,
      '/settings/selected_model',
    );
    if (settingsRes) {
      const parsed = JSON.parse(settingsRes.value);
      if (parsed && parsed.modelId) {
        return {
          source: parsed.source || 'cloud',
          provider: parsed.provider,
          modelId: parsed.modelId,
          displayName: parsed.displayName || parsed.modelId,
        };
      }
    }
  } catch {
    // Settings not found, continue to fallback
  }

  // 3. Claude Code (if detected and available)
  const claudeInfo = getCachedClaudeCodeInfo();
  if (claudeInfo.status === 'available') {
    return {
      source: 'claude-code',
      modelId: 'claude-code',
      displayName: 'Claude Code',
    };
  }

  // 4. Currently loaded local model
  try {
    const status = await backendGet<{ state: string; loaded_model_id: string | null }>(
      backendPort,
      '/models/status',
    );
    if (status && status.state === 'ready' && status.loaded_model_id) {
      return {
        source: 'local',
        modelId: status.loaded_model_id,
        displayName: status.loaded_model_id,
      };
    }
  } catch {
    // No local model
  }

  return null;
}

function backendGet<T>(port: number, path: string): Promise<T | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      if (res.statusCode !== 200) {
        resolve(null);
        res.resume();
        return;
      }
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data) as T);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(null);
    });
  });
}
