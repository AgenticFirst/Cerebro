export type ModelTier = 'starter' | 'balanced' | 'power';
export type ModelStatus = 'available' | 'downloading' | 'downloaded' | 'interrupted';
export type EngineState = 'idle' | 'loading' | 'ready' | 'error';
export type Architecture = 'dense' | 'moe';

export interface LocalModel {
  id: string;
  name: string;
  family: string;
  variant: string;
  description: string;
  tagline: string;
  tier: ModelTier;
  size_bytes: number;
  context_length: number;
  architecture: Architecture;
  total_params: string;
  active_params: string;
  hf_repo: string;
  hf_filename: string;
  requires_ram_gb: number;
  recommended_ram_gb: number;
  status: ModelStatus;
  file_path: string | null;
  sha256: string | null;
  downloaded_at: string | null;
}

export interface DownloadProgress {
  status: 'downloading' | 'verifying' | 'completed' | 'cancelled' | 'error' | 'interrupted';
  downloaded_bytes: number;
  total_bytes: number;
  speed_bps: number;
  eta_seconds: number;
  file_path?: string;
  error?: string;
}

export interface EngineStatus {
  state: EngineState;
  loaded_model_id: string | null;
  error: string | null;
}

export interface HardwareInfo {
  total_ram_gb: number;
  available_ram_gb: number;
  gpu_name: string | null;
  gpu_vram_gb: number | null;
}

export interface ModelCatalogResponse {
  models: LocalModel[];
  recommended_model_id: string | null;
}
