#!/usr/bin/env node
/**
 * Generates `src/constants/avatars.generated.ts` from the existing avatar
 * PNG filenames in `src/assets/avatars/`.
 *
 * Each filename like `guide-dog.png` is mapped to its unicode emoji char
 * by looking up the slug (`guide_dog`) in `unicode-emoji-json`.
 * Filenames that don't resolve are dropped with a warning so the picker
 * never renders a blank avatar.
 *
 * Run with `node scripts/generate-avatar-mapping.mjs`. Re-run whenever
 * the avatar set changes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AVATAR_DIR = path.join(ROOT, 'src', 'assets', 'avatars');
const OUTPUT = path.join(ROOT, 'src', 'constants', 'avatars.generated.ts');
const EMOJI_DATA = path.join(ROOT, 'node_modules', 'unicode-emoji-json', 'data-by-emoji.json');

const dataByEmoji = JSON.parse(fs.readFileSync(EMOJI_DATA, 'utf8'));

// Build slug → emoji map for fast lookup. The same emoji can appear
// under several slugs across versions; the first one wins.
const slugToEmoji = new Map();
const slugToMeta = new Map();
for (const [emoji, meta] of Object.entries(dataByEmoji)) {
  if (!slugToEmoji.has(meta.slug)) {
    slugToEmoji.set(meta.slug, emoji);
    slugToMeta.set(meta.slug, meta);
  }
}

const filenames = fs
  .readdirSync(AVATAR_DIR)
  .filter((f) => f.endsWith('.png'))
  .map((f) => f.replace(/\.png$/, ''))
  .sort();

const mapped = [];
const unmapped = [];

for (const id of filenames) {
  // PNG filenames use kebab-case; emoji slugs use snake_case.
  const slug = id.replace(/-/g, '_');
  const emoji = slugToEmoji.get(slug);
  if (!emoji) {
    unmapped.push(id);
    continue;
  }
  const meta = slugToMeta.get(slug);
  // Build search keywords from the slug parts plus the group name.
  const keywords = [...slug.split('_'), ...meta.group.toLowerCase().split(/[\s&]+/).filter(Boolean)];
  mapped.push({
    id,
    label: titleCase(id),
    emoji,
    keywords: Array.from(new Set(keywords)),
    group: meta.group,
  });
}

function titleCase(id) {
  return id
    .split('-')
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

const header = `/**
 * GENERATED FILE — do NOT edit by hand.
 *
 * Source: scripts/generate-avatar-mapping.mjs
 * Inputs:
 *   - src/assets/avatars/*.png filenames (id namespace, kept stable)
 *   - unicode-emoji-json (slug → unicode char)
 *
 * Mapped:   ${mapped.length}
 * Unmapped: ${unmapped.length} (file names with no matching CLDR slug)
 *
 * Re-run with: node scripts/generate-avatar-mapping.mjs
 */

import type { AvatarOption } from './avatars';

export const GENERATED_AVATAR_OPTIONS: AvatarOption[] = ${JSON.stringify(mapped, null, 2)};
`;

fs.writeFileSync(OUTPUT, header);
console.log(`[avatars] mapped ${mapped.length} / ${mapped.length + unmapped.length} avatars to unicode emoji`);
if (unmapped.length > 0) {
  console.log(`[avatars] dropped ${unmapped.length} avatars without a CLDR slug match (sample):`);
  console.log('  ', unmapped.slice(0, 10).join(', '));
}
