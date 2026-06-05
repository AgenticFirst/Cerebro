/**
 * Pure helpers for turning agent-memory directory slugs into friendly labels
 * and filtering the agent list — issue #66.
 *
 * The on-disk memory directory for an expert is `slugify(name)-<hash>` (see
 * `src/shared/agent-name.ts`). Those slugs are unreadable in the UI, so we map
 * each known slug back to its expert's display name and fall back to a
 * de-kebabbed, hash-stripped version for slugs we can't resolve.
 */

import { expertAgentName } from '../../../shared/agent-name';

export interface AgentLike {
  id: string;
  name: string;
}

/** Display name for the top-level Cerebro main agent's memory directory. */
export const CEREBRO_SLUG = 'cerebro';
export const CEREBRO_LABEL = 'Cerebro';

// Trailing 6-char base36 hash appended by `expertAgentName`.
const HASH_SUFFIX_RE = /-[0-9a-z]{6}$/;

/** Build a `slug -> friendly name` map from the known experts/teams. */
export function buildSlugLabelMap(experts: AgentLike[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of experts) {
    if (!e?.id || !e?.name) continue;
    map.set(expertAgentName(e.id, e.name), e.name);
  }
  return map;
}

/** Turn `principal-ios-engineer-rdww8x` into `Principal Ios Engineer`. */
function humanizeSlug(slug: string): string {
  const base = slug.replace(HASH_SUFFIX_RE, '');
  const words = base.split('-').filter(Boolean);
  if (words.length === 0) return slug;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Resolve a memory directory slug to the friendliest label we can produce:
 * the expert's display name when known, then "Cerebro" for the main agent,
 * then a de-kebabbed, hash-stripped fallback.
 */
export function resolveAgentLabel(slug: string, labels: Map<string, string>): string {
  const known = labels.get(slug);
  if (known) return known;
  if (slug === CEREBRO_SLUG) return CEREBRO_LABEL;
  return humanizeSlug(slug);
}

/** True when the query matches the friendly label or the raw slug. */
export function matchesQuery(label: string, slug: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return label.toLowerCase().includes(q) || slug.toLowerCase().includes(q);
}
