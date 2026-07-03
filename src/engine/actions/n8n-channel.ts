/**
 * Minimal interface the n8n engine actions depend on.
 * Implemented by N8nManager (src/n8n/manager.ts) — kept here so action
 * factories can import it without dragging the manager into the engine layer.
 */

export interface N8nChannel {
  /** Public API key minted during provisioning, or null before first run. */
  getApiKey(): string | null;
  /** http://127.0.0.1:<port> while the managed instance is running. */
  getEditorBaseUrl(): string | null;
  /** True when the instance is running and an API key exists. Used by the
   *  chat-actions catalog to decide if n8n actions are runnable. */
  isConnected(): boolean;
  /** Notifies the Flows screen that a workflow was created/updated so the
   *  embedded canvas can navigate to it. Best-effort, never throws. */
  notifyWorkflowTouched(workflowId: string): void;
}

export interface N8nChannelDeps {
  getChannel: () => N8nChannel | null;
}

/** Resolves the live channel + credentials or throws the uniform
 *  "n8n is not running / not provisioned" error every n8n action shares. */
export function requireN8nChannel(
  deps: N8nChannelDeps,
  actionName: string,
): { channel: N8nChannel; apiKey: string; baseUrl: string } {
  const channel = deps.getChannel();
  if (!channel || !channel.isConnected()) {
    throw new Error(`${actionName} — n8n is not running. Open Flows or Integrations to start it.`);
  }
  const apiKey = channel.getApiKey();
  const baseUrl = channel.getEditorBaseUrl();
  if (!apiKey || !baseUrl) {
    throw new Error(`${actionName} — n8n has no API key yet. Re-run setup from Integrations.`);
  }
  return { channel, apiKey, baseUrl };
}

/** Chat-exposure metadata shared by every n8n action definition. */
export function n8nActionDefaults(deps: N8nChannelDeps) {
  return {
    chatExposable: true as const,
    chatGroup: 'n8n',
    availabilityCheck: (): 'available' | 'not_connected' => {
      const ch = deps.getChannel();
      return ch && ch.isConnected() ? 'available' : 'not_connected';
    },
    setupHref: 'integrations#n8n',
  };
}
