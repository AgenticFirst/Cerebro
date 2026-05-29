/**
 * Centralized connection-status fetcher. Mirrors the pattern in
 * UseTemplateDialog.refreshConnections, so callers (RoutineContext,
 * routine-template setup, etc.) all see consistent results.
 *
 * Returns a record indexed by connection id. Connections we don't know
 * about are simply absent from the map — caller should treat absence as
 * "not applicable" rather than "disconnected."
 */

export type ConnectionId = 'hubspot' | 'whatsapp' | 'telegram';

export interface ConnectionStatusMap {
  hubspot?: boolean;
  whatsapp?: boolean;
  telegram?: boolean;
}

export async function fetchConnectionStatus(
  needed: readonly ConnectionId[],
): Promise<ConnectionStatusMap> {
  const out: ConnectionStatusMap = {};
  // Run all fetches in parallel — no reason to serialize.
  const tasks: Promise<void>[] = [];

  if (needed.includes('hubspot')) {
    tasks.push(
      window.cerebro.hubspot.status()
        .then((s) => { out.hubspot = s.hasToken; })
        .catch(() => { /* leave undefined → caller treats as unknown */ }),
    );
  }
  if (needed.includes('whatsapp')) {
    tasks.push(
      window.cerebro.whatsapp.status()
        .then((s) => { out.whatsapp = s.state === 'connected'; })
        .catch(() => { /* unknown */ }),
    );
  }
  if (needed.includes('telegram')) {
    tasks.push(
      window.cerebro.telegram.status()
        .then((s) => { out.telegram = Boolean(s.hasToken); })
        .catch(() => { /* unknown */ }),
    );
  }

  await Promise.all(tasks);
  return out;
}
