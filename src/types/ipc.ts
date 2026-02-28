// --- IPC Channel Constants ---

export const IPC_CHANNELS = {
  BACKEND_REQUEST: 'backend:request',
  BACKEND_STATUS: 'backend:status',
  STREAM_START: 'backend:stream-start',
  STREAM_CANCEL: 'backend:stream-cancel',
  // Stream events are sent on dynamic channels: `backend:stream-event:${streamId}`
  streamEvent: (streamId: string) => `backend:stream-event:${streamId}`,
} as const;

// --- Backend Request/Response ---

export interface BackendRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface BackendResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
}

// --- Backend Status ---

export type BackendStatus = 'starting' | 'healthy' | 'unhealthy' | 'stopped';

// --- Streaming ---

export interface StreamRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

export interface StreamEvent {
  event: 'data' | 'error' | 'end';
  data: string;
}

// --- Preload API exposed on window.cerebro ---

export interface CerebroAPI {
  invoke<T = unknown>(request: BackendRequest): Promise<BackendResponse<T>>;
  getStatus(): Promise<BackendStatus>;
  startStream(request: StreamRequest): Promise<string>;
  cancelStream(streamId: string): Promise<void>;
  onStream(streamId: string, callback: (event: StreamEvent) => void): () => void;
}
