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

import type { ActionDefinition, ActionInput, ActionOutput } from './actions/types';

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
};

/**
 * Returns a wrapped ActionDefinition whose `execute` returns synthetic
 * success when a stub exists for its type. Actions without a stub
 * (condition, loop, delay, transformer, etc.) are returned unchanged so
 * the routine's actual control flow is exercised.
 */
export function wrapForDryRun(action: ActionDefinition): ActionDefinition {
  const stub = STUBS[action.type];
  if (!stub) return action;
  return {
    ...action,
    execute: async (input: ActionInput): Promise<ActionOutput> => {
      // Still log the call so the caller can see "dry-run skipped this".
      input.context.log(`[dry-run] ${action.type}: skipping side effects`);
      return Promise.resolve(stub(input));
    },
  };
}
