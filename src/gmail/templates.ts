/**
 * Email template rendering — HubSpot-style personalization tokens.
 *
 * Syntax: `{{first_name}}` or `{{first_name|there}}` (fallback after `|`).
 * Rendering fails loudly when a token has neither a value nor a fallback —
 * the caller surfaces the missing list so nobody ships "Hi {{first_name}}".
 */

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_]+)(?:\s*\|([^}]*))?\s*\}\}/g;

export interface RenderResult {
  ok: boolean;
  text: string;
  missing: string[];
}

export function renderEmailTemplate(
  template: string,
  variables: Record<string, string | number | null | undefined>,
): RenderResult {
  const missing = new Set<string>();
  const text = template.replace(TOKEN_RE, (_m, name: string, fallback?: string) => {
    const val = variables[name];
    if (val !== undefined && val !== null && String(val).trim() !== '') return String(val);
    if (fallback !== undefined) return fallback.trim();
    missing.add(name);
    return `{{${name}}}`;
  });
  return { ok: missing.size === 0, text, missing: [...missing] };
}

/** Variable names referenced in a template (fallbacks excluded). */
export function templateVariables(template: string): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(TOKEN_RE)) out.add(m[1]);
  return [...out];
}
