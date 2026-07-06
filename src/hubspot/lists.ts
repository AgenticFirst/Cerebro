/**
 * HubSpot Lists (a.k.a. "segments") helpers.
 *
 * Lists are NOT plain CRM objects — they live under their own v3 surface:
 *   POST   /crm/v3/lists/                          create
 *   GET    /crm/v3/lists/{listId}                  read
 *   POST   /crm/v3/lists/search                    list / search
 *   PUT    /crm/v3/lists/{listId}/update-list-name rename (name as query param)
 *   DELETE /crm/v3/lists/{listId}                  archive
 *   PUT    /crm/v3/lists/{listId}/memberships/add     add records
 *   PUT    /crm/v3/lists/{listId}/memberships/remove  remove records
 *
 * Only MANUAL (static) lists accept manual membership changes; DYNAMIC lists
 * are populated by HubSpot from their filters, so `updateMemberships` against
 * one returns HubSpot's error verbatim. Built on `callHubSpotApi` for shared
 * auth + error handling.
 */

import { callHubSpotApi } from './api';

/** Default object type for a new list — contacts. */
const CONTACTS_OBJECT_TYPE_ID = '0-1';

export type ListProcessingType = 'MANUAL' | 'DYNAMIC';

export interface HubSpotList {
  listId: string;
  name: string;
  processingType: string | null;
  objectTypeId: string | null;
  size: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface RawList {
  listId?: string | number;
  name?: string;
  processingType?: string;
  objectTypeId?: string;
  createdAt?: string;
  updatedAt?: string;
  additionalProperties?: { hs_list_size?: string };
}

function normalizeList(raw: RawList | undefined | null): HubSpotList | null {
  if (!raw || raw.listId === undefined || raw.listId === null) return null;
  const sizeStr = raw.additionalProperties?.hs_list_size;
  const size =
    sizeStr !== undefined && sizeStr !== '' && !Number.isNaN(Number(sizeStr))
      ? Number(sizeStr)
      : null;
  return {
    listId: String(raw.listId),
    name: raw.name ?? '',
    processingType: raw.processingType ?? null,
    objectTypeId: raw.objectTypeId ?? null,
    size,
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt ?? null,
  };
}

export const LIST_SORT_FIELDS = ['created_at', 'updated_at', 'name', 'size'] as const;
export type ListSortBy = (typeof LIST_SORT_FIELDS)[number];
export type ListSortDirection = 'asc' | 'desc';

export interface ListListsResult {
  lists: HubSpotList[];
  total: number;
  hasMore: boolean;
  nextOffset: number;
  error: string | null;
}

/** Max lists per search request — HubSpot's documented cap for `count`. */
const SEARCH_PAGE_MAX = 500;
/** Safety cap on how many lists a sorted search will scan across pages. */
const SORT_SCAN_MAX = 5000;

interface SearchPage {
  lists: HubSpotList[];
  total: number;
  hasMore: boolean;
}

async function searchListsPage(
  token: string,
  params: { query?: string; count: number; offset: number; signal?: AbortSignal },
): Promise<{ ok: true; data: SearchPage } | { ok: false; error: string }> {
  const body: Record<string, unknown> = {
    count: params.count,
    offset: params.offset,
    additionalProperties: ['hs_list_size'],
  };
  if (params.query) body.query = params.query;
  const res = await callHubSpotApi<{ lists?: RawList[]; total?: number; hasMore?: boolean }>(
    token,
    '/crm/v3/lists/search',
    { method: 'POST', body, signal: params.signal },
  );
  if (!res.ok) return { ok: false, error: res.error };
  const lists = (res.data?.lists ?? [])
    .map(normalizeList)
    .filter((l): l is HubSpotList => l !== null);
  return {
    ok: true,
    data: {
      lists,
      total: res.data?.total ?? lists.length,
      hasMore: res.data?.hasMore ?? false,
    },
  };
}

function sortValue(list: HubSpotList, sortBy: ListSortBy): string | number | null {
  switch (sortBy) {
    case 'created_at':
      return list.createdAt;
    case 'updated_at':
      return list.updatedAt;
    case 'name':
      return list.name || null;
    case 'size':
      return list.size;
  }
}

/** Sorts in place — callers pass arrays they own. */
function sortLists(
  lists: HubSpotList[],
  sortBy: ListSortBy,
  direction: ListSortDirection,
): HubSpotList[] {
  const sign = direction === 'asc' ? 1 : -1;
  return lists.sort((a, b) => {
    const va = sortValue(a, sortBy);
    const vb = sortValue(b, sortBy);
    if (va === null && vb === null) return 0;
    if (va === null) return 1; // nulls last regardless of direction
    if (vb === null) return -1;
    if (va < vb) return -sign;
    if (va > vb) return sign;
    return 0;
  });
}

/**
 * Search lists by name and/or page through them. Without `sortBy` this is a
 * single request at `offset`. With `sortBy`, HubSpot's search endpoint has no
 * usable server-side sort, so this pages through the whole catalog (up to
 * SORT_SCAN_MAX lists), sorts locally, and slices — the only way to reliably
 * answer "the newest segment" when there are more lists than one page.
 */
export async function listLists(
  token: string,
  opts: {
    query?: string;
    limit?: number;
    offset?: number;
    sortBy?: ListSortBy;
    sortDirection?: ListSortDirection;
    signal?: AbortSignal;
  } = {},
): Promise<ListListsResult> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), SEARCH_PAGE_MAX);
  const offset = Math.max(opts.offset ?? 0, 0);

  if (!opts.sortBy) {
    const res = await searchListsPage(token, {
      query: opts.query,
      count: limit,
      offset,
      signal: opts.signal,
    });
    if (!res.ok)
      return { lists: [], total: 0, hasMore: false, nextOffset: offset, error: res.error };
    const { lists, total, hasMore } = res.data;
    return { lists, total, hasMore, nextOffset: offset + lists.length, error: null };
  }

  const direction = opts.sortDirection ?? (opts.sortBy === 'name' ? 'asc' : 'desc');
  const all: HubSpotList[] = [];
  let total = 0;
  let scanOffset = 0;
  for (;;) {
    const res = await searchListsPage(token, {
      query: opts.query,
      count: SEARCH_PAGE_MAX,
      offset: scanOffset,
      signal: opts.signal,
    });
    if (!res.ok)
      return { lists: [], total: 0, hasMore: false, nextOffset: offset, error: res.error };
    const page = res.data.lists;
    all.push(...page);
    total = Math.max(res.data.total, all.length);
    if (!res.data.hasMore || page.length === 0 || all.length >= SORT_SCAN_MAX) break;
    scanOffset += page.length;
  }

  const sorted = sortLists(all, opts.sortBy, direction);
  const lists = sorted.slice(offset, offset + limit);
  return {
    lists,
    total,
    hasMore: sorted.length > offset + limit,
    nextOffset: offset + lists.length,
    error: null,
  };
}

export interface GetListResult {
  list: HubSpotList | null;
  error: string | null;
}

/** Fetch a single list by id. */
export async function getList(
  token: string,
  listId: string,
  signal?: AbortSignal,
): Promise<GetListResult> {
  const res = await callHubSpotApi<{ list?: RawList }>(
    token,
    `/crm/v3/lists/${encodeURIComponent(listId)}`,
    { method: 'GET', signal },
  );
  if (!res.ok) return { list: null, error: res.error };
  return { list: normalizeList(res.data?.list), error: null };
}

export interface CreateListResult {
  listId: string | null;
  error: string | null;
}

/** Create a list. Defaults to a MANUAL (static) contacts list. */
export async function createList(
  token: string,
  params: { name: string; processingType?: ListProcessingType; objectTypeId?: string },
  signal?: AbortSignal,
): Promise<CreateListResult> {
  const res = await callHubSpotApi<{ list?: RawList }>(token, '/crm/v3/lists/', {
    method: 'POST',
    body: {
      name: params.name,
      objectTypeId: params.objectTypeId ?? CONTACTS_OBJECT_TYPE_ID,
      processingType: params.processingType ?? 'MANUAL',
    },
    signal,
  });
  if (!res.ok) return { listId: null, error: res.error };
  const normalized = normalizeList(res.data?.list);
  return { listId: normalized?.listId ?? null, error: null };
}

export interface ListMutationResult {
  ok: boolean;
  error: string | null;
}

/** Rename a list. HubSpot takes the new name as a query parameter. */
export async function renameList(
  token: string,
  listId: string,
  name: string,
  signal?: AbortSignal,
): Promise<ListMutationResult> {
  const res = await callHubSpotApi(
    token,
    `/crm/v3/lists/${encodeURIComponent(listId)}/update-list-name?listName=${encodeURIComponent(name)}`,
    { method: 'PUT', signal },
  );
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, error: null };
}

/** Archive (delete) a list. The records themselves are not deleted. */
export async function deleteList(
  token: string,
  listId: string,
  signal?: AbortSignal,
): Promise<ListMutationResult> {
  const res = await callHubSpotApi(token, `/crm/v3/lists/${encodeURIComponent(listId)}`, {
    method: 'DELETE',
    signal,
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, error: null };
}

export interface UpdateMembershipsResult {
  /** Number of records actually added/removed (best-effort from the response). */
  updated: number;
  error: string | null;
}

/**
 * Add or remove records (e.g. contact ids) to/from a MANUAL list. Returns an
 * error from HubSpot when called on a DYNAMIC list.
 */
export async function updateMemberships(
  token: string,
  listId: string,
  mode: 'add' | 'remove',
  recordIds: string[],
  signal?: AbortSignal,
): Promise<UpdateMembershipsResult> {
  const ids = recordIds.map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) return { updated: 0, error: 'No record ids were provided.' };

  const res = await callHubSpotApi<{ recordsIdsAdded?: string[]; recordsIdsRemoved?: string[] }>(
    token,
    `/crm/v3/lists/${encodeURIComponent(listId)}/memberships/${mode}`,
    { method: 'PUT', body: ids, signal },
  );
  if (!res.ok) return { updated: 0, error: res.error };
  const changed = mode === 'add' ? res.data?.recordsIdsAdded : res.data?.recordsIdsRemoved;
  const updated = Array.isArray(changed) ? changed.length : ids.length;
  return { updated, error: null };
}
