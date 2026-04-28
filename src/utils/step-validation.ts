/**
 * Pre-run validation for required step params. The backend enforces these
 * too, but catching them here lets us abort "Run Now" with a targeted
 * toast instead of the user staring at a 5-minute hang ending in a
 * UUID-only timeout error.
 *
 * Only action types whose missing params produce a silent/confusing run
 * failure belong here — keep the list tight and aligned with the inline
 * validation in StepConfigPanel.
 */

import { resolveActionType } from './step-defaults';
import type { DAGDefinition } from '../engine/dag/types';

export interface StepValidationIssue {
  stepId: string;
  stepName: string;
  field: string;
  message: string;
}

/**
 * Live-resource context for validation. Optional — the validator works
 * without it, but resource checks (expert exists, HubSpot connected) are
 * only run when the relevant field is provided.
 */
export interface ValidationContext {
  experts?: { id: string }[];
  hubspotConnected?: boolean;
}

function isBlank(v: unknown): boolean {
  return typeof v !== 'string' || v.trim().length === 0;
}

export function validateDagParams(
  dag: DAGDefinition,
  ctx: ValidationContext = {},
): StepValidationIssue[] {
  const issues: StepValidationIssue[] = [];
  const expertIds = ctx.experts ? new Set(ctx.experts.map((e) => e.id)) : null;

  for (const step of dag.steps) {
    const resolved = resolveActionType(step.actionType);
    const p = step.params ?? {};
    const name = step.name;

    const push = (field: string, message: string) => {
      issues.push({ stepId: step.id, stepName: name, field, message });
    };

    switch (resolved) {
      case 'ask_ai':
        if (isBlank(p.prompt)) push('prompt', `"${name}" (Ask AI) is missing a prompt`);
        break;

      case 'run_expert': {
        if (isBlank(p.expertId)) {
          push('expertId', `"${name}" (Run Expert) — pick an expert`);
        } else if (expertIds && !expertIds.has(String(p.expertId))) {
          push('expertId', `"${name}" — assigned expert no longer exists`);
        }
        if (isBlank(p.prompt)) {
          push('prompt', `"${name}" (Run Expert) is missing a prompt`);
        }
        break;
      }

      case 'hubspot_create_ticket': {
        if (isBlank(p.subject)) {
          push('subject', `"${name}" (HubSpot Ticket) needs a subject`);
        }
        if (ctx.hubspotConnected === false) {
          push('connection', `"${name}" — connect HubSpot in Integrations first`);
        }
        break;
      }

      case 'hubspot_upsert_contact': {
        if (isBlank(p.email)) {
          push('email', `"${name}" (HubSpot Contact) needs an email`);
        }
        if (ctx.hubspotConnected === false) {
          push('connection', `"${name}" — connect HubSpot in Integrations first`);
        }
        break;
      }

      case 'http_request':
        if (isBlank(p.url)) push('url', `"${name}" (HTTP Request) is missing a URL`);
        break;

      case 'send_message':
        if (isBlank(p.message)) push('message', `"${name}" (Send Message) is missing a message`);
        break;

      case 'send_notification':
        if (isBlank(p.title)) push('title', `"${name}" (Desktop Notification) is missing a headline`);
        break;

      case 'send_telegram_message': {
        if (isBlank(p.chat_id)) push('chat_id', `"${name}" (Telegram) is missing a chat ID`);
        if (isBlank(p.message)) push('message', `"${name}" (Telegram) is missing a message`);
        break;
      }

      case 'send_whatsapp_message': {
        if (isBlank(p.phone_number)) push('phone_number', `"${name}" (WhatsApp) is missing a phone number`);
        if (isBlank(p.message)) push('message', `"${name}" (WhatsApp) is missing a message`);
        break;
      }
    }
  }
  return issues;
}
