/**
 * Main-process-safe translator for integration bridges (Slack, Telegram, …).
 *
 * The renderer uses react-i18next via `./index`, which can't run in Electron's
 * main process. Bridges instead import the plain locale objects directly (pure
 * data — no React) and resolve a dotted key + `{{var}}` interpolation against
 * them, falling back to English when a key is missing in the target language.
 *
 * Keep bridge-facing strings under the locale files' `slackBridge` (etc.)
 * sections so they live alongside every other user-facing string, per the
 * project's bilingual rule.
 */

import en from './locales/en';
import es from './locales/es';

export type BridgeLang = 'en' | 'es';

const RESOURCES: Record<BridgeLang, unknown> = { en, es };

/** Map an arbitrary language/locale tag ("es", "es-ES", "EN-us") to a supported
 *  bridge language. Anything that isn't Spanish falls back to English. */
export function normalizeBridgeLang(raw?: string | null): BridgeLang {
  return raw && raw.toLowerCase().startsWith('es') ? 'es' : 'en';
}

function lookup(root: unknown, key: string): unknown {
  let node: unknown = root;
  for (const part of key.split('.')) {
    if (node && typeof node === 'object' && part in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return node;
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/**
 * Translate `key` (e.g. "slackBridge.filesReceived") into `lang`, interpolating
 * `{{var}}` placeholders. Falls back to English, then to the raw key, so a
 * missing translation degrades gracefully instead of throwing.
 */
export function bridgeT(
  lang: BridgeLang,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const localized = lookup(RESOURCES[lang], key);
  const value = typeof localized === 'string' ? localized : lookup(RESOURCES.en, key);
  return typeof value === 'string' ? interpolate(value, vars) : key;
}
