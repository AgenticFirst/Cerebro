# IPC Bridge

IPC stands for **Inter-Process Communication** &mdash; it's how Electron's isolated processes talk to each other. The IPC bridge is the communication layer between Cerebro's React renderer and the Python backend. Because Electron enforces process isolation for security, the renderer cannot make network requests directly to the backend. Instead, every call flows through a structured pipeline: **Renderer &rarr; Preload &rarr; Main Process &rarr; Python**.

## Architecture

### Request / Response

```
Renderer              Preload               Main Process          Python
   |                     |                       |                   |
   |  cerebro.invoke()   |                       |                   |
   |-------------------->|  ipcRenderer.invoke    |                   |
   |                     |---------------------->|  http.request     |
   |                     |                       |------------------>|
   |                     |                       |                   |
   |                     |                       |  HTTP response    |
   |                     |                       |<------------------|
   |                     |  { ok, status, data } |                   |
   |  Promise resolves   |<----------------------|                   |
   |<--------------------|                       |                   |
   |                     |                       |                   |
```

### Streaming (SSE)

For long-running operations like LLM responses, the bridge supports server-sent event (SSE) streaming. The main process holds the HTTP connection open and pushes chunks to the renderer as they arrive.

```
Renderer              Preload               Main Process          Python
   |                     |                       |                   |
   |  startStream(req)   |                       |                   |
   |-------------------->|  invoke(STREAM_START)  |                   |
   |                     |---------------------->|  http.request     |
   |                     |                       |------------------>|
   |                     |       returns streamId |                   |
   |  onStream(id, cb)   |                       |                   |
   |-------------------->|  ipcRenderer.on        |                   |
   |                     |                       |   data: chunk1    |
   |                     |  webContents.send      |<------------------|
   |  callback(chunk1)   |<----------------------|                   |
   |<--------------------|                       |   data: chunk2    |
   |                     |  webContents.send      |<------------------|
   |  callback(chunk2)   |<----------------------|                   |
   |<--------------------|                       |                   |
   |                     |                       |   (stream ends)   |
   |                     |  { event: 'end' }     |<------------------|
   |  callback(end)      |<----------------------|                   |
   |<--------------------|                       |                   |
   |                     |                       |                   |
```

## Key Files

| File | Role |
|------|------|
| [`src/types/ipc.ts`](../../src/types/ipc.ts) | Shared type contract &mdash; channel constants, request/response interfaces, `CerebroAPI` definition |
| [`src/types/global.d.ts`](../../src/types/global.d.ts) | Augments `Window` so `window.cerebro` is typed throughout the renderer |
| [`src/preload.ts`](../../src/preload.ts) | Thin forwarding layer exposed via `contextBridge.exposeInMainWorld` |
| [`src/main.ts`](../../src/main.ts) | IPC handlers that proxy HTTP to the Python backend |

## API Reference

All methods are available on `window.cerebro` in the renderer.

### `invoke<T>(request): Promise<BackendResponse<T>>`

Send a request to any Python endpoint. This is the primary method &mdash; adding new backend routes requires zero bridge changes.

```ts
// GET
const res = await window.cerebro.invoke({ method: 'GET', path: '/health' });
// res = { ok: true, status: 200, data: { status: 'ok' } }

// POST with body
const res = await window.cerebro.invoke({
  method: 'POST',
  path: '/chat',
  body: { message: 'Hello' },
});
```

### `getStatus(): Promise<BackendStatus>`

Returns the current backend lifecycle state.

```ts
const status = await window.cerebro.getStatus();
// 'starting' | 'healthy' | 'unhealthy' | 'stopped'
```

### `startStream(request): Promise<string>`

Opens an SSE connection to the backend. Returns a `streamId` used to subscribe to events and to cancel.

```ts
const streamId = await window.cerebro.startStream({
  method: 'POST',
  path: '/chat/stream',
  body: { message: 'Tell me a story' },
});
```

### `onStream(streamId, callback): () => void`

Subscribe to events on an active stream. Returns an unsubscribe function (designed for React effect cleanup).

```ts
const unsubscribe = window.cerebro.onStream(streamId, (event) => {
  if (event.event === 'data') console.log(event.data);
  if (event.event === 'error') console.error(event.data);
  if (event.event === 'end') console.log('Stream finished');
});

// Later, or in useEffect cleanup:
unsubscribe();
```

### `cancelStream(streamId): Promise<void>`

Abort an active stream. Destroys the underlying HTTP connection.

```ts
await window.cerebro.cancelStream(streamId);
```

## Design Decisions

**One generic channel.** Rather than registering a separate IPC channel per endpoint, the bridge uses a single `backend:request` channel that accepts `{ method, path, body }`. This keeps the bridge stable as the backend API grows.

**Errors resolve, never reject.** `invoke()` always resolves with `{ ok: false, status, data }` on failure, matching `fetch()` semantics. This avoids scattered try/catch blocks in React components.

**Context isolation.** The preload script uses Electron's `contextBridge` to expose a minimal, typed API. The renderer has no access to `ipcRenderer`, Node APIs, or the backend port &mdash; only the five methods on `window.cerebro`.

**Main process as HTTP proxy.** The backend port lives exclusively in the main process. The renderer never learns it. This keeps the security boundary clean and lets the main process track backend health, manage timeouts, and handle SSE parsing in one place.
