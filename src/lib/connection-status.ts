/**
 * Centralized connection-status fetcher. Mirrors the pattern in
 * UseTemplateDialog.refreshConnections, so callers (RoutineContext,
 * routine-template setup, etc.) all see consistent results.
 *
 * Returns a record indexed by connection id. Connections we don't know
 * about are simply absent from the map — caller should treat absence as
 * "not applicable" rather than "disconnected."
 */

import { resolveActionType } from '../utils/step-defaults';
import type { DAGDefinition } from '../engine/dag/types';

export type ConnectionId = 'hubspot' | 'whatsapp' | 'telegram' | 'github';

export interface ConnectionStatusMap {
  hubspot?: boolean;
  whatsapp?: boolean;
  telegram?: boolean;
  github?: boolean;
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
  if (needed.includes('github')) {
    tasks.push(
      window.cerebro.github.status()
        .then((s) => { out.github = s.hasToken; })
        .catch(() => { /* unknown */ }),
    );
  }

  await Promise.all(tasks);
  return out;
}

/**
 * Decide which live connection statuses a DAG needs probed before a run.
 * Combines action-type-implied connections (e.g. any `github_*` step needs
 * GitHub, `hubspot_*` needs HubSpot) with the union of `requiredConnections`
 * declared by every expert the DAG references via `run_expert`.
 *
 * Keeping this here (rather than inline in RoutineContext) means the Run Now
 * pre-validation and any future caller agree on the same set — the bug in #25
 * was that GitHub was silently omitted, so `githubConnected` was never set and
 * the not-connected guard in validateDagParams could never fire.
 */
export function connectionsNeededForDag(
  dag: DAGDefinition,
  experts: { id: string; requiredConnections?: string[] | null }[] = [],
): ConnectionId[] {
  const needs = new Set<ConnectionId>();

  for (const step of dag.steps) {
    const resolved = resolveActionType(step.actionType);
    if (resolved === 'hubspot_create_ticket' || resolved === 'hubspot_upsert_contact') {
      needs.add('hubspot');
    }
    // Integration GitHub actions are `github_*`; the inbound triggers are
    // `trigger_github_*`, which don't require an outbound connection to run.
    if (resolved.startsWith('github_')) {
      needs.add('github');
    }
  }

  // Experts the DAG references via run_expert contribute their declared
  // requiredConnections.
  const referencedExperts = dag.steps
    .filter((s) => resolveActionType(s.actionType) === 'run_expert')
    .map((s) => experts.find((e) => e.id === String(s.params?.expertId ?? '')))
    .filter((e): e is NonNullable<typeof e> => Boolean(e));
  for (const expert of referencedExperts) {
    for (const conn of expert.requiredConnections ?? []) {
      if (conn === 'hubspot' || conn === 'whatsapp' || conn === 'telegram' || conn === 'github') {
        needs.add(conn);
      }
    }
  }

  return [...needs];
}
