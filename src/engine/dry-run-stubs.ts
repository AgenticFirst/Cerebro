/**
 * Dry-run stubs for the routine engine.
 *
 * When a routine is dry-run (e.g. before saving a Cerebro-proposed routine),
 * we still want to exercise the executor — wiring, templates, branch
 * conditions, schemas — but we must not actually call HubSpot, send a
 * Telegram, mutate disk, or burn LLM tokens. Each side-effecty action gets
 * a synthetic stub that returns plausible output matching the real output
 * schema so downstream steps still wire up correctly.
 *
 * Anything safe to run for real in a dry run (condition, loop, transformer,
 * delay capped to 0ms, send_message that targets the local conversation
 * log only, search_memory which is read-only) is left alone — the goal is
 * to surface real failures, not turn the routine into a no-op.
 */

import type { ActionDefinition, ActionInput, ActionOutput, JSONSchema } from './actions/types';
import { renderTemplate } from './actions/utils/template';

const DRY_RUN_ID_PREFIX = 'dryrun-';

function syntheticId(prefix = DRY_RUN_ID_PREFIX): string {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Per-action-type stub outputs. Keys MUST match `ActionDefinition.type`.
 * Stubs receive the same `ActionInput` the real action would, so they can
 * still validate templated inputs and surface errors like missing required
 * params.
 */
const STUBS: Record<string, (input: ActionInput) => ActionOutput | Promise<ActionOutput>> = {
  hubspot_create_ticket: () => ({
    data: {
      ticket_id: syntheticId('dryrun-ticket-'),
      ticket_url: null,
      created: true,
      error: null,
    },
    summary: '[dry-run] Would create HubSpot ticket',
  }),
  hubspot_upsert_contact: () => ({
    data: {
      contact_id: syntheticId('dryrun-contact-'),
      created: true,
      matched_by: null,
      error: null,
    },
    summary: '[dry-run] Would upsert HubSpot contact',
  }),
  send_telegram_message: (input) => ({
    data: {
      sent: true,
      message_id: 0,
      chat_id: String((input.params as Record<string, unknown>).chat_id ?? ''),
      error: null,
    },
    summary: '[dry-run] Would send Telegram message',
  }),
  send_whatsapp_message: (input) => ({
    data: {
      sent: true,
      message_id: syntheticId('dryrun-wamsg-'),
      phone_number: String((input.params as Record<string, unknown>).phone_number ?? ''),
      error: null,
    },
    summary: '[dry-run] Would send WhatsApp message',
  }),
  send_email: () => ({
    data: { sent: true, message_id: syntheticId('dryrun-email-'), error: null },
    summary: '[dry-run] Would send email',
  }),
  send_message: (input) => ({
    data: { sent: true, message_id: syntheticId('dryrun-msg-') },
    summary: `[dry-run] Would post: ${String((input.params as Record<string, unknown>).message ?? '').slice(0, 40)}`,
  }),
  send_notification: (input) => ({
    data: {
      sent: true,
      title: String((input.params as Record<string, unknown>).title ?? ''),
      body: String((input.params as Record<string, unknown>).body ?? ''),
    },
    summary: '[dry-run] Would show desktop notification',
  }),

  // HTTP and shell — destructive enough that dry-run shouldn't actually fire
  // them. The synthetic 200 response is chosen so downstream `condition`
  // steps that branch on `status >= 200` still take the success branch.
  http_request: (input) => ({
    data: {
      status: 200,
      body: { dryRun: true },
      headers: { 'content-type': 'application/json' },
      duration_ms: 0,
    },
    summary: `[dry-run] Would call ${String((input.params as Record<string, unknown>).method ?? 'GET').toUpperCase()} ${String((input.params as Record<string, unknown>).url ?? '')}`,
  }),
  run_command: () => ({
    data: { stdout: '[dry-run]', stderr: '', exit_code: 0, duration_ms: 0 },
    summary: '[dry-run] Would run shell command',
  }),
  run_script: () => ({
    data: { stdout: '[dry-run]', stderr: '', exit_code: 0 },
    summary: '[dry-run] Would run script',
  }),
  run_claude_code: () => ({
    data: { ok: true, output: '[dry-run] Would run Claude Code', stderr: '', exit_code: 0 },
    summary: '[dry-run] Would run Claude Code subprocess',
  }),

  // LLM-shaped actions. Returning a non-empty string lets `extract`/`classify`
  // downstreams that wire on `result` still receive a populated value.
  ask_ai: () => ({
    data: { response: '[dry-run] simulated LLM response', result: '[dry-run] simulated LLM response' },
    summary: '[dry-run] Would ask the model',
  }),
  model_call: () => ({
    data: { response: '[dry-run] simulated LLM response', result: '[dry-run] simulated LLM response' },
    summary: '[dry-run] Would ask the model',
  }),
  classify: () => ({
    data: { category: 'dry-run-stub', confidence: 1, reasoning: '[dry-run]' },
    summary: '[dry-run] Would classify input',
  }),
  extract: () => ({
    data: { extracted: { dryRun: true }, raw: '[dry-run]' },
    summary: '[dry-run] Would extract structured fields',
  }),
  summarize: () => ({
    data: { summary: '[dry-run] simulated summary', result: '[dry-run] simulated summary' },
    summary: '[dry-run] Would summarize input',
  }),
  run_expert: () => ({
    data: { response: '[dry-run] simulated expert response', result: '[dry-run] simulated expert response' },
    summary: '[dry-run] Would invoke an expert',
  }),
  expert_step: () => ({
    data: { response: '[dry-run] simulated expert response', result: '[dry-run] simulated expert response' },
    summary: '[dry-run] Would invoke an expert',
  }),

  // Knowledge — keep cheap. Real read-only actions could run, but synthesizing
  // skips network/DB load on a dry run that may execute every few seconds.
  search_memory: () => ({
    data: { results: [], total: 0 },
    summary: '[dry-run] Would search memory',
  }),
  search_web: () => ({
    data: { results: [], answer: null, total: 0 },
    summary: '[dry-run] Would search the web',
  }),
  search_documents: () => ({
    data: { results: [], total: 0 },
    summary: '[dry-run] Would search documents',
  }),
  save_to_memory: () => ({
    data: { saved: true, item_id: syntheticId('dryrun-mem-') },
    summary: '[dry-run] Would save to memory',
  }),

  // Workflow control — the trigger / wait actions don't make sense in a
  // dry-run; short-circuit them so the run completes quickly.
  wait_for_webhook: () => ({
    data: { received: true, payload: { dryRun: true } },
    summary: '[dry-run] Would wait for webhook',
  }),
  approval_gate: () => ({
    data: { approved: true, dry_run: true },
    summary: '[dry-run] Approval gate auto-passed',
  }),

  // channel (legacy alias of send_message)
  channel: () => ({
    data: { sent: true, message_id: syntheticId('dryrun-msg-') },
    summary: '[dry-run] Would broadcast message',
  }),

  // GitHub
  github_create_issue: () => ({
    data: {
      issue_number: 1,
      issue_url: 'https://github.com/dryrun/repo/issues/1',
      created: true,
      error: null,
    },
    summary: '[dry-run] Would create GitHub issue',
  }),
  github_comment_issue: () => ({
    data: {
      comment_id: 1,
      comment_url: 'https://github.com/dryrun/repo/issues/1#issuecomment-1',
      created: true,
      error: null,
    },
    summary: '[dry-run] Would comment on GitHub issue',
  }),
  github_comment_pr: () => ({
    data: {
      comment_id: 1,
      comment_url: 'https://github.com/dryrun/repo/pull/1#issuecomment-1',
      created: true,
      error: null,
    },
    summary: '[dry-run] Would comment on GitHub PR',
  }),
  github_review_pr: (input) => {
    const event = String((input.params as Record<string, unknown>).event ?? 'COMMENT');
    return {
      data: {
        review_id: 1,
        review_url: 'https://github.com/dryrun/repo/pull/1#pullrequestreview-1',
        submitted: true,
        error: null,
      },
      summary: `[dry-run] Would submit ${event} review`,
    };
  },
  github_open_pr: () => ({
    data: {
      pr_number: 1,
      pr_url: 'https://github.com/dryrun/repo/pull/1',
      created: true,
      error: null,
    },
    summary: '[dry-run] Would open GitHub PR',
  }),
  github_fetch_issue: (input) => ({
    data: {
      ok: true,
      error: null,
      issue_number: 1,
      title: '[dry-run issue title]',
      body: '[dry-run issue body]',
      author_login: 'dryrun-user',
      labels: [],
      html_url: `https://github.com/${String((input.params as Record<string, unknown>).repo ?? 'dryrun/repo')}/issues/1`,
      comments: [],
    },
    summary: '[dry-run] Would fetch GitHub issue',
  }),
  github_fetch_pr: (input) => ({
    data: {
      ok: true,
      error: null,
      pr_number: 1,
      title: '[dry-run pr title]',
      body: '[dry-run pr body]',
      author_login: 'dryrun-user',
      head_ref: 'feature/dryrun',
      base_ref: 'main',
      head_sha: 'deadbeef',
      html_url: `https://github.com/${String((input.params as Record<string, unknown>).repo ?? 'dryrun/repo')}/pull/1`,
      draft: false,
      changed_files: 0,
      additions: 0,
      deletions: 0,
      diff: '',
      diff_truncated: false,
    },
    summary: '[dry-run] Would fetch GitHub PR',
  }),
  github_clone_worktree: () => ({
    data: {
      worktree_path: '/tmp/dryrun-worktree',
      base_branch: 'main',
      ok: true,
      error: null,
    },
    summary: '[dry-run] Would clone repo into a worktree',
  }),
  github_commit_and_push: (input) => ({
    data: {
      commit_sha: 'deadbeef',
      branch: String((input.params as Record<string, unknown>).branch ?? 'cerebro/dryrun'),
      no_changes: false,
      ok: true,
      error: null,
    },
    summary: '[dry-run] Would commit and push branch',
  }),

  // Delay — short-circuit so a routine with a 1-hour wait doesn't make the
  // dry-run sit for an hour. The real delay action would also reject
  // duration <= 0, so we accept any duration here.
  delay: (input) => {
    const params = input.params as Record<string, unknown>;
    return {
      data: {
        delayed_ms: 0,
        completed_at: new Date().toISOString(),
        ...input.wiredInputs,
      },
      summary: `[dry-run] Would wait ${String(params.duration ?? '?')} ${String(params.unit ?? '?')}`,
    };
  },
};

/**
 * Validate that every required field in the action's inputSchema is
 * populated. Strings are rendered against wiredInputs so a template like
 * `{{customer_email}}` that points at a non-existent upstream field will
 * surface as "required field empty after rendering" instead of slipping
 * through the synthetic-success stub. This is what makes the dry-run
 * actually catch broken wiring before users hit production.
 */
function validateRequiredParams(
  schema: JSONSchema,
  params: Record<string, unknown>,
  wiredInputs: Record<string, unknown>,
): void {
  const required = (schema as { required?: string[] }).required;
  if (!Array.isArray(required) || required.length === 0) return;
  for (const field of required) {
    const value = params[field];
    if (value === undefined || value === null) {
      throw new Error(`Required field "${field}" is missing from this step's params.`);
    }
    if (typeof value === 'string') {
      const rendered = renderTemplate(value, wiredInputs).trim();
      if (!rendered) {
        throw new Error(
          `Required field "${field}" is empty after template rendering. ` +
          `Check that upstream steps actually produce the variables you reference.`,
        );
      }
    }
  }
}

/**
 * Returns a wrapped ActionDefinition whose `execute` returns synthetic
 * success when a stub exists for its type. Actions without a stub
 * (condition, loop, delay, transformer, etc.) are returned unchanged so
 * the routine's actual control flow is exercised. Either way, every
 * wrapped execute first validates required params so the dry-run catches
 * missing fields and broken templates before the synthetic success.
 */
export function wrapForDryRun(action: ActionDefinition): ActionDefinition {
  const stub = STUBS[action.type];
  if (!stub) return action;
  return {
    ...action,
    execute: async (input: ActionInput): Promise<ActionOutput> => {
      validateRequiredParams(action.inputSchema, input.params, input.wiredInputs);
      input.context.log(`[dry-run] ${action.type}: skipping side effects`);
      return Promise.resolve(stub(input));
    },
  };
}
