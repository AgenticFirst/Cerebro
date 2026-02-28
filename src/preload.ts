import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from './types/ipc';
import type { BackendRequest, BackendResponse, BackendStatus, StreamRequest, StreamEvent, CerebroAPI } from './types/ipc';

const api: CerebroAPI = {
  invoke<T = unknown>(request: BackendRequest): Promise<BackendResponse<T>> {
    return ipcRenderer.invoke(IPC_CHANNELS.BACKEND_REQUEST, request);
  },

  getStatus(): Promise<BackendStatus> {
    return ipcRenderer.invoke(IPC_CHANNELS.BACKEND_STATUS);
  },

  startStream(request: StreamRequest): Promise<string> {
    return ipcRenderer.invoke(IPC_CHANNELS.STREAM_START, request);
  },

  cancelStream(streamId: string): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.STREAM_CANCEL, streamId);
  },

  onStream(streamId: string, callback: (event: StreamEvent) => void): () => void {
    const channel = IPC_CHANNELS.streamEvent(streamId);
    const listener = (_event: Electron.IpcRendererEvent, data: StreamEvent) => {
      callback(data);
    };
    ipcRenderer.on(channel, listener);

    // Return unsubscribe function
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
};

contextBridge.exposeInMainWorld('cerebro', api);
