import Mustache from 'mustache';

/**
 * Render a Mustache template with HTML escaping disabled.
 *
 * Use this for text destined for an LLM, a desktop notification banner, or
 * any other non-HTML sink — default Mustache escapes `<`, `>`, `&`, etc.,
 * which mangles prompts and plain-text UI.
 */
export function renderTemplate(source: string, vars: Record<string, unknown>): string {
  if (!source) return '';
  return Mustache.render(source, vars, undefined, { escape: (v) => String(v) });
}
