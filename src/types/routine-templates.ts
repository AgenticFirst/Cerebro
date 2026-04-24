/**
 * Routine template types.
 *
 * A RoutineTemplate is a blueprint the Routines screen can turn into a real
 * routine in a few clicks. Templates are bundled with the app (see
 * src/routine-templates/index.ts) — there is no backend templates API yet.
 *
 * Variables in `dagJson` use %%name%% placeholders so they don't collide
 * with Mustache {{...}} expressions the routine itself renders at run time.
 */

import type { TriggerType } from './routines';

export type RoutineTemplateCategory =
  | 'customer_support'
  | 'productivity'
  | 'integrations'
  | 'other';

export type RequiredConnection =
  | 'whatsapp'
  | 'hubspot'
  | 'telegram'
  | 'tavily'
  | 'anthropic'
  | 'openai'
  | 'google'
  | string;

export type TemplateVariableType =
  | 'text'
  | 'textarea'
  | 'select'
  | 'hubspot_pipeline'
  | 'hubspot_stage';

export interface TemplateSelectOption {
  value: string;
  label: string;
}

export interface TemplateVariable {
  /** Short key used as %%key%% placeholder in dagJson and triggerConfig. */
  key: string;
  /** User-facing label on the Customize step of UseTemplateDialog. */
  label: string;
  /** One-sentence hint displayed under the field. */
  description: string;
  type: TemplateVariableType;
  placeholder?: string;
  required: boolean;
  default?: string;
  options?: TemplateSelectOption[];
  /** Stage variable reads its parent pipeline from this other variable's value
   *  (so the stage dropdown only shows stages of the selected pipeline). */
  dependsOnVariable?: string;
}

export interface RoutineTemplate {
  id: string;
  name: string;
  description: string;
  category: RoutineTemplateCategory;
  /** Integrations the template depends on. UseTemplateDialog gates instantiation
   *  on each being configured. */
  requiredConnections: RequiredConnection[];
  /** Plain-English bullet list — the "what this routine does" summary that
   *  shows on the routine card and the template preview. */
  plainEnglishSteps: string[];
  /** Full DAG JSON as a string. %%var_name%% placeholders are substituted
   *  against the user's TemplateVariable answers at instantiation. */
  dagJson: string;
  triggerType: TriggerType;
  /** Trigger config copy. Same placeholder conventions as dagJson. */
  triggerConfig: Record<string, unknown>;
  variables: TemplateVariable[];
}
