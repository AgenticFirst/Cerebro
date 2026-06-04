/**
 * Shared resolution for the "rich" ticket fields used by both
 * hubspot_create_ticket and hubspot_update_ticket: owner-by-name/email,
 * follow-up user, and due date.
 *
 * Owner and follow-up user are HubSpot user references — the chat agent knows a
 * person by name or email, so we resolve that to the numeric owner id. Follow-up
 * user and due date are custom ticket properties whose internal names differ per
 * portal, so they're written to the property names configured in the HubSpot
 * Integrations settings. Anything unresolved or unconfigured is skipped with a
 * clear warning rather than aborting the ticket operation.
 */

import type { HubSpotChannel } from '../engine/actions/hubspot-channel';
import { resolveOwner } from './owners';

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

export interface NormalizeDateResult {
  /** Midnight-UTC epoch milliseconds as a string (HubSpot `date` format), or null. */
  value: string | null;
  warning?: string;
}

/**
 * Normalize a user-supplied date to HubSpot's `date` property format: midnight
 * UTC epoch milliseconds. Accepts `YYYY-MM-DD` or any ISO datetime; the time of
 * day is truncated to midnight UTC. Returns a warning (and a null value) when
 * the input can't be parsed.
 */
export function normalizeHubSpotDate(input: string): NormalizeDateResult {
  const raw = (input ?? '').trim();
  if (!raw) return { value: null };
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    return { value: null, warning: `Unparseable due date "${raw}" — skipped` };
  }
  // Truncate to midnight UTC so a "date" property gets a clean day boundary.
  const midnight = ms - (((ms % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY);
  return { value: String(midnight) };
}

/**
 * Format a HubSpot date property value for display as `YYYY-MM-DD`. HubSpot
 * returns `date` properties either as midnight-UTC epoch milliseconds or as an
 * ISO date string depending on the endpoint, so handle both. Returns the raw
 * value unchanged when it can't be parsed.
 */
export function formatHubSpotDate(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (Number.isNaN(ms)) return raw;
  return new Date(ms).toISOString().slice(0, 10);
}

export interface BuildTicketExtrasInput {
  channel: HubSpotChannel;
  token: string;
  signal?: AbortSignal;
  log: (msg: string) => void;
  /** Owner given by name/email/id (preferred). */
  owner?: string;
  /** Legacy raw owner id, used only when `owner` is empty. */
  ownerId?: string;
  /** Follow-up user given by name/email/id. */
  followUpUser?: string;
  /** Due date as `YYYY-MM-DD` or ISO. */
  dueDate?: string;
}

export interface BuildTicketExtrasResult {
  /** HubSpot internal property name → value, ready to merge into the ticket body. */
  props: Record<string, string>;
  warnings: string[];
  /** Resolved owner id written (or null). */
  ownerResolved: string | null;
  /** Resolved follow-up owner id written (or null). */
  followUpResolved: string | null;
  /** Normalized due-date value written (or null). */
  dueDateSet: string | null;
}

/**
 * Resolve owner / follow-up user / due date into a flat property map. Each field
 * is independent and best-effort: a field that can't be resolved (ambiguous
 * name, missing owners scope) or whose target custom property isn't configured
 * is skipped and reported in `warnings`, never thrown.
 */
export async function buildTicketExtras(
  in_: BuildTicketExtrasInput,
): Promise<BuildTicketExtrasResult> {
  const { channel, token, signal, log } = in_;
  const props: Record<string, string> = {};
  const warnings: string[] = [];
  let ownerResolved: string | null = null;
  let followUpResolved: string | null = null;
  let dueDateSet: string | null = null;

  // Owner: resolve name/email/id, falling back to a legacy raw id.
  const ownerQuery = (in_.owner ?? '').trim();
  if (ownerQuery) {
    const res = await resolveOwner(token, ownerQuery, signal, log);
    if (res.ownerId) {
      props.hubspot_owner_id = res.ownerId;
      ownerResolved = res.ownerId;
    } else if (res.error) {
      warnings.push(`Owner not set — ${res.error}`);
    }
  } else if ((in_.ownerId ?? '').trim()) {
    props.hubspot_owner_id = in_.ownerId!.trim();
    ownerResolved = in_.ownerId!.trim();
  }

  // Follow-up user: resolve like an owner, write to the configured property.
  const followUpQuery = (in_.followUpUser ?? '').trim();
  if (followUpQuery) {
    const prop = (channel.getFollowUpProperty() ?? '').trim();
    if (!prop) {
      warnings.push(
        'Follow-up user not set — no follow-up property is configured in the HubSpot integration settings',
      );
    } else {
      const res = await resolveOwner(token, followUpQuery, signal, log);
      if (res.ownerId) {
        props[prop] = res.ownerId;
        followUpResolved = res.ownerId;
      } else if (res.error) {
        warnings.push(`Follow-up user not set — ${res.error}`);
      }
    }
  }

  // Due date: normalize, write to the configured property.
  const dueRaw = (in_.dueDate ?? '').trim();
  if (dueRaw) {
    const prop = (channel.getDueDateProperty() ?? '').trim();
    if (!prop) {
      warnings.push(
        'Due date not set — no due-date property is configured in the HubSpot integration settings',
      );
    } else {
      const { value, warning } = normalizeHubSpotDate(dueRaw);
      if (value) {
        props[prop] = value;
        dueDateSet = value;
      } else if (warning) {
        warnings.push(warning);
      }
    }
  }

  return { props, warnings, ownerResolved, followUpResolved, dueDateSet };
}
