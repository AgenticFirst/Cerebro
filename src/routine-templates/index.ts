/**
 * Bundled routine templates.
 *
 * Today there's one — the WhatsApp/HubSpot customer-support flow. Add new
 * templates by importing them here; the Routines screen's Templates tab
 * renders whatever this array contains.
 */

import type { RoutineTemplate } from '../types/routine-templates';
import { customerSupportWhatsAppHubSpotTemplate } from './customer-support-whatsapp-hubspot';

export const ROUTINE_TEMPLATES: RoutineTemplate[] = [
  customerSupportWhatsAppHubSpotTemplate,
];

export function getTemplateById(id: string): RoutineTemplate | null {
  return ROUTINE_TEMPLATES.find((t) => t.id === id) ?? null;
}

/**
 * Substitute %%key%% placeholders in a template string with user-supplied
 * values. Unknown keys are replaced with empty strings so a missing variable
 * doesn't leak the placeholder syntax to end users.
 */
export function applyTemplateVariables(
  source: string,
  values: Record<string, string>,
): string {
  return source.replace(/%%(\w+)%%/g, (_, key) => {
    const v = values[key];
    return typeof v === 'string' ? v : '';
  });
}

/**
 * Render a template's dagJson + triggerConfig with the user's variable
 * answers, returning the finished routine create payload.
 */
export function materializeTemplate(
  template: RoutineTemplate,
  values: Record<string, string>,
): {
  name: string;
  description: string;
  dagJson: string;
  triggerType: RoutineTemplate['triggerType'];
  triggerConfig: Record<string, unknown>;
  requiredConnections: string[];
  plainEnglishSteps: string[];
} {
  // dagJson is already a valid JSON string; substituting %%var%% in-place
  // keeps it valid as long as template authors avoid placeholders inside
  // JSON-syntactic positions (property keys, bare numbers). That's a stable
  // contract — all placeholders today live inside string values.
  const dagJson = applyTemplateVariables(template.dagJson, values);

  const triggerConfig: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(template.triggerConfig)) {
    triggerConfig[k] = typeof v === 'string' ? applyTemplateVariables(v, values) : v;
  }

  return {
    name: applyTemplateVariables(template.name, values),
    description: applyTemplateVariables(template.description, values),
    dagJson,
    triggerType: template.triggerType,
    triggerConfig,
    requiredConnections: template.requiredConnections,
    plainEnglishSteps: template.plainEnglishSteps.map((s) => applyTemplateVariables(s, values)),
  };
}
