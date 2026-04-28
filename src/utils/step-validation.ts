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
 * without it, but resource checks (expert exists/enabled, connection
 * status, model in known list, Claude Code authenticated) are only run
 * when the relevant field is provided.
 */
export interface ValidationContext {
  experts?: { id: string; isEnabled?: boolean; requiredConnections?: string[] | null }[];
  hubspotConnected?: boolean;
  whatsappConnected?: boolean;
  telegramConnected?: boolean;
  /** Allowlist of Claude model IDs. When set, `params.model` is validated against it. */
  knownModels?: string[];
  /** True iff the caller probed Claude Code auth before invoking the validator. */
  claudeCodeAuthChecked?: boolean;
  /** When `claudeCodeAuthChecked` is true: result of the probe. undefined → skip. */
  claudeCodeAuthOk?: boolean;
  /** Optional reason returned by the probe — surfaced verbatim in the toast. */
  claudeCodeAuthReason?: string;
}

function isBlank(v: unknown): boolean {
  return typeof v !== 'string' || v.trim().length === 0;
}

const CONNECTION_LABEL: Record<string, string> = {
  hubspot: 'HubSpot',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
};

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
        if (!isBlank(p.model) && ctx.knownModels && !ctx.knownModels.includes(String(p.model))) {
          push('model', `"${name}" — model "${p.model}" not in the known list. Pick one from the model menu.`);
        }
        break;

      case 'run_expert': {
        if (isBlank(p.expertId)) {
          push('expertId', `"${name}" (Run Expert) — pick an expert`);
        } else if (ctx.experts) {
          const expertId = String(p.expertId);
          const expert = ctx.experts.find((e) => e.id === expertId);
          if (!expert) {
            push('expertId', `"${name}" — assigned expert no longer exists`);
          } else if (expert.isEnabled === false) {
            push('expertId', `"${name}" — assigned expert is disabled. Re-enable it on the Experts screen.`);
          } else if (expert.requiredConnections && expert.requiredConnections.length > 0) {
            const missing = expert.requiredConnections.filter((c) => {
              if (c === 'hubspot') return ctx.hubspotConnected === false;
              if (c === 'whatsapp') return ctx.whatsappConnected === false;
              if (c === 'telegram') return ctx.telegramConnected === false;
              return false;
            });
            if (missing.length > 0) {
              const labels = missing.map((c) => CONNECTION_LABEL[c] ?? c).join(', ');
              push('connection', `"${name}" — expert needs ${labels}; connect it on Integrations.`);
            }
          }
        }
        if (isBlank(p.prompt)) {
          push('prompt', `"${name}" (Run Expert) is missing a prompt`);
        }
        if (!isBlank(p.model) && ctx.knownModels && !ctx.knownModels.includes(String(p.model))) {
          push('model', `"${name}" — model "${p.model}" not in the known list. Pick one from the model menu.`);
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

  // Run-level: Claude Code auth probe. Any step that ultimately spawns a
  // `claude` subprocess needs the CLI authenticated. The probe is async
  // and gated on whether the caller actually ran it.
  if (ctx.claudeCodeAuthChecked && ctx.claudeCodeAuthOk === false) {
    const usesClaudeCode = dag.steps.some((s) => {
      const r = resolveActionType(s.actionType);
      return r === 'run_expert' || r === 'ask_ai' || r === 'run_claude_code';
    });
    if (usesClaudeCode) {
      const reason = ctx.claudeCodeAuthReason ? ` Reason: ${ctx.claudeCodeAuthReason}` : '';
      issues.push({
        stepId: '__run__',
        stepName: 'Claude Code',
        field: 'auth',
        message: `Claude Code isn't authenticated. Run \`claude\` in a terminal to log in, then re-run.${reason}`,
      });
    }
  }

  return issues;
}
