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
  githubConnected?: boolean;
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
  github: 'GitHub',
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
              if (c === 'github') return ctx.githubConnected === false;
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

      case 'github_create_issue': {
        if (isBlank(p.repo)) push('repo', `"${name}" (GitHub Issue) is missing the repo (owner/name)`);
        if (isBlank(p.title)) push('title', `"${name}" (GitHub Issue) is missing a title`);
        if (ctx.githubConnected === false) push('connection', `"${name}" — connect GitHub in Integrations first`);
        break;
      }
      case 'github_comment_issue': {
        if (isBlank(p.repo)) push('repo', `"${name}" (GitHub Comment) is missing the repo`);
        if (isBlank(String(p.issue_number ?? ''))) push('issue_number', `"${name}" (GitHub Comment) is missing the issue number`);
        if (isBlank(p.body)) push('body', `"${name}" (GitHub Comment) is missing a body`);
        if (ctx.githubConnected === false) push('connection', `"${name}" — connect GitHub in Integrations first`);
        break;
      }
      case 'github_comment_pr': {
        if (isBlank(p.repo)) push('repo', `"${name}" (GitHub PR Comment) is missing the repo`);
        if (isBlank(String(p.pr_number ?? ''))) push('pr_number', `"${name}" (GitHub PR Comment) is missing the PR number`);
        if (isBlank(p.body)) push('body', `"${name}" (GitHub PR Comment) is missing a body`);
        if (ctx.githubConnected === false) push('connection', `"${name}" — connect GitHub in Integrations first`);
        break;
      }
      case 'github_review_pr': {
        if (isBlank(p.repo)) push('repo', `"${name}" (GitHub PR Review) is missing the repo`);
        if (isBlank(String(p.pr_number ?? ''))) push('pr_number', `"${name}" (GitHub PR Review) is missing the PR number`);
        if (ctx.githubConnected === false) push('connection', `"${name}" — connect GitHub in Integrations first`);
        break;
      }
      case 'github_open_pr': {
        if (isBlank(p.repo)) push('repo', `"${name}" (GitHub Open PR) is missing the repo`);
        if (isBlank(p.base)) push('base', `"${name}" (GitHub Open PR) is missing the base branch`);
        if (isBlank(p.head)) push('head', `"${name}" (GitHub Open PR) is missing the head branch`);
        if (isBlank(p.title)) push('title', `"${name}" (GitHub Open PR) is missing a title`);
        if (ctx.githubConnected === false) push('connection', `"${name}" — connect GitHub in Integrations first`);
        break;
      }
      case 'github_fetch_issue':
      case 'github_fetch_pr':
      case 'github_clone_worktree': {
        if (isBlank(p.repo)) push('repo', `"${name}" — repo is required (owner/name)`);
        if (ctx.githubConnected === false) push('connection', `"${name}" — connect GitHub in Integrations first`);
        break;
      }
      case 'github_commit_and_push': {
        if (isBlank(p.worktree_path)) push('worktree_path', `"${name}" (Commit & Push) is missing the worktree path`);
        if (isBlank(p.branch)) push('branch', `"${name}" (Commit & Push) is missing a branch name`);
        if (isBlank(p.commit_message)) push('commit_message', `"${name}" (Commit & Push) is missing a commit message`);
        if (ctx.githubConnected === false) push('connection', `"${name}" — connect GitHub in Integrations first`);
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
