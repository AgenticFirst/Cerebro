/**
 * Gmail → local-store sync (one account per call).
 *
 * Strategy (developers.google.com/gmail/api/guides/sync):
 *   - First run: windowed full sync — list message ids newer than the window,
 *     fetch bodies, batch-upsert into the backend store, remember the profile
 *     historyId.
 *   - After that: incremental `users.history.list(startHistoryId)`. Gmail keeps
 *     ~1 week of history; a 404 (surfaced as `expired`) falls back to the
 *     windowed sync, skipping messages the store already has.
 *
 * Pure orchestration over api.ts + the /gmail/* backend endpoints — no tokens
 * are handled here (the bridge passes a live access token per call).
 */

import { backendJsonRequest } from '../shared/backend-settings';
import { ProviderHttpError } from '../shared/oauth';
import * as api from './api';
import type { GmailMessageSummary } from './types';

export const SYNC_WINDOW_DAYS = 90;
/** Cap on messages fetched in one windowed backfill (API cost control). */
export const FULL_SYNC_MAX_MESSAGES = 500;
const UPSERT_BATCH_SIZE = 50;

export interface SyncDeps {
  backendPort: number;
  accountId: string;
  accessToken: string;
  /** Stored history cursor; null forces a windowed full sync. */
  historyId: string | null;
  log?: (msg: string) => void;
}

export interface SyncOutcome {
  newHistoryId: string | null;
  fullSync: boolean;
  changed: boolean;
  /** New inbound (INBOX, non-outbound) messages — routine triggers + labeling. */
  inboundNew: GmailMessageSummary[];
  /** Provider thread ids touched (AI labeling / summary invalidation). */
  touchedThreadIds: string[];
}

interface UpsertPayload {
  message_id: string;
  thread_id: string;
  from_addr: string | null;
  to_addrs: string | null;
  cc_addrs: string | null;
  subject: string | null;
  snippet: string | null;
  body_text: string | null;
  body_html: string | null;
  label_ids: string[];
  internal_date: string | null;
  is_outbound: boolean;
  attachments: Array<{
    attachmentId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
  }>;
}

function toUpsert(raw: api.RawMessage): UpsertPayload {
  const full = api.toFull(raw);
  return {
    message_id: full.id,
    thread_id: full.threadId,
    from_addr: full.from || null,
    to_addrs: full.to || null,
    cc_addrs: full.cc || null,
    subject: full.subject || null,
    snippet: full.snippet || null,
    body_text: full.bodyText || null,
    // HTML kept for the reader; search only indexes the text body.
    body_html: full.bodyHtml,
    label_ids: full.labelIds,
    internal_date: full.receivedAt,
    is_outbound: full.labelIds.includes('SENT'),
    attachments: full.attachments,
  };
}

function isInboundNew(raw: api.RawMessage): boolean {
  const labels = raw.labelIds ?? [];
  return labels.includes('INBOX') && !labels.includes('SENT') && !labels.includes('DRAFT');
}

async function pushBatch(
  deps: SyncDeps,
  upserts: UpsertPayload[],
  deletions: string[],
  labelUpdates: Record<string, string[]>,
): Promise<string[]> {
  if (!upserts.length && !deletions.length && !Object.keys(labelUpdates).length) return [];
  const res = await backendJsonRequest<{ touched_thread_ids: string[] }>(
    deps.backendPort,
    'POST',
    '/gmail/sync',
    {
      account_id: deps.accountId,
      upserts,
      deletions,
      label_updates: labelUpdates,
    },
  );
  if (!res.ok) throw new Error(`gmail store sync failed: HTTP ${res.status}`);
  return res.data?.touched_thread_ids ?? [];
}

/** Concurrent Gmail fetches per chunk — well under per-user quota, ~10× less
 *  wall-clock than sequential awaits on the sync hot path. */
const FETCH_CONCURRENCY = 10;

/** Fetch messages by id in concurrent chunks, tolerating 404s (purged remotely). */
async function fetchMessages(
  deps: SyncDeps,
  ids: string[],
  format: 'full' | 'minimal',
): Promise<api.RawMessage[]> {
  const out: api.RawMessage[] = [];
  for (let i = 0; i < ids.length; i += FETCH_CONCURRENCY) {
    const chunk = await Promise.all(
      ids.slice(i, i + FETCH_CONCURRENCY).map(async (id) => {
        try {
          return await api.getMessage(deps.accessToken, id, format);
        } catch (err) {
          if (err instanceof ProviderHttpError && err.status === 404) return null;
          throw err;
        }
      }),
    );
    out.push(...chunk.filter((m): m is api.RawMessage => m !== null));
  }
  return out;
}

const fetchFullMessages = (deps: SyncDeps, ids: string[]) => fetchMessages(deps, ids, 'full');

async function windowedFullSync(deps: SyncDeps): Promise<SyncOutcome> {
  deps.log?.(`windowed full sync (last ${SYNC_WINDOW_DAYS}d)`);
  const profile = await api.getProfile(deps.accessToken);

  // Ids already stored — skip their bodies on re-sync after cursor expiry.
  const known = await backendJsonRequest<{ message_ids: string[] }>(
    deps.backendPort,
    'GET',
    `/gmail/known-ids?account_id=${encodeURIComponent(deps.accountId)}`,
  );
  const knownIds = new Set(known.data?.message_ids ?? []);

  const ids: string[] = [];
  let pageToken: string | undefined;
  while (ids.length < FULL_SYNC_MAX_MESSAGES) {
    const page = await api.listMessages(deps.accessToken, {
      q: `newer_than:${SYNC_WINDOW_DAYS}d`,
      maxResults: Math.min(100, FULL_SYNC_MAX_MESSAGES - ids.length),
      pageToken,
    });
    for (const m of page.messages ?? []) ids.push(m.id);
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }

  const toFetch = ids.filter((id) => !knownIds.has(id));
  const touched = new Set<string>();
  const inboundNew: api.RawMessage[] = [];
  for (let i = 0; i < toFetch.length; i += UPSERT_BATCH_SIZE) {
    const raws = await fetchFullMessages(deps, toFetch.slice(i, i + UPSERT_BATCH_SIZE));
    for (const t of await pushBatch(deps, raws.map(toUpsert), [], {})) {
      touched.add(t);
    }
    // Only count truly-new inbox mail on the very first sync's most recent page
    // as "inbound new" — no triggers fire for the historical backfill.
    if (knownIds.size > 0) inboundNew.push(...raws.filter(isInboundNew));
  }

  return {
    newHistoryId: profile.historyId ?? null,
    fullSync: true,
    changed: toFetch.length > 0,
    inboundNew: inboundNew.map((r) => api.toSummary(r)),
    touchedThreadIds: [...touched],
  };
}

async function incrementalSync(deps: SyncDeps, startHistoryId: string): Promise<SyncOutcome> {
  const added = new Set<string>();
  const deleted = new Set<string>();
  const relabeled = new Set<string>();
  let latestHistoryId: string | null = null;
  let pageToken: string | undefined;

  for (;;) {
    const page = await api.listHistory(deps.accessToken, startHistoryId, pageToken);
    if (page.expired) {
      deps.log?.('history cursor expired — falling back to windowed sync');
      return windowedFullSync(deps);
    }
    latestHistoryId = page.historyId ?? latestHistoryId;
    for (const h of page.history ?? []) {
      for (const a of h.messagesAdded ?? []) added.add(a.message.id);
      for (const d of h.messagesDeleted ?? []) {
        deleted.add(d.message.id);
        added.delete(d.message.id);
      }
      for (const l of [...(h.labelsAdded ?? []), ...(h.labelsRemoved ?? [])]) {
        if (!added.has(l.message.id) && !deleted.has(l.message.id)) relabeled.add(l.message.id);
      }
    }
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }

  if (!added.size && !deleted.size && !relabeled.size) {
    return {
      newHistoryId: latestHistoryId ?? startHistoryId,
      fullSync: false,
      changed: false,
      inboundNew: [],
      touchedThreadIds: [],
    };
  }

  const addedRaws = await fetchFullMessages(deps, [...added]);

  // Label-only changes: re-read current labels via cheap metadata fetches.
  const labelUpdates: Record<string, string[]> = {};
  for (const meta of await fetchMessages(deps, [...relabeled], 'minimal')) {
    labelUpdates[meta.id] = meta.labelIds ?? [];
  }

  const touched = new Set<string>();
  for (let i = 0; i < addedRaws.length; i += UPSERT_BATCH_SIZE) {
    const slice = addedRaws.slice(i, i + UPSERT_BATCH_SIZE);
    for (const t of await pushBatch(deps, slice.map(toUpsert), [], {})) touched.add(t);
  }
  for (const t of await pushBatch(deps, [], [...deleted], labelUpdates)) touched.add(t);

  return {
    newHistoryId: latestHistoryId ?? startHistoryId,
    fullSync: false,
    changed: true,
    inboundNew: addedRaws.filter(isInboundNew).map((r) => api.toSummary(r)),
    touchedThreadIds: [...touched],
  };
}

export async function syncGmailAccount(deps: SyncDeps): Promise<SyncOutcome> {
  if (!deps.historyId) return windowedFullSync(deps);
  return incrementalSync(deps, deps.historyId);
}
