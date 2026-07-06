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
  hubspot_create_ticket: (input) => {
    const hasContact = Boolean(
      String((input.params as Record<string, unknown>).contact_id ?? '').trim() ||
      String((input.params as Record<string, unknown>).contact_email ?? '').trim(),
    );
    return {
      data: {
        ticket_id: syntheticId('dryrun-ticket-'),
        ticket_url: null,
        created: true,
        contact_id: hasContact ? syntheticId('dryrun-contact-') : null,
        contact_associated: hasContact,
        owner_resolved: null,
        follow_up_resolved: null,
        due_date_set: null,
        warnings: [],
        error: null,
      },
      summary: '[dry-run] Would create HubSpot ticket',
    };
  },
  hubspot_upsert_contact: () => ({
    data: {
      contact_id: syntheticId('dryrun-contact-'),
      created: true,
      matched_by: null,
      error: null,
    },
    summary: '[dry-run] Would upsert HubSpot contact',
  }),
  hubspot_search_contact: (input) => ({
    data: {
      found: true,
      contact_id: syntheticId('dryrun-contact-'),
      email: String((input.params as Record<string, unknown>).email ?? '') || null,
      firstname: '[dry-run]',
      lastname: '[dry-run]',
      error: null,
    },
    summary: '[dry-run] Would search HubSpot contact',
  }),
  hubspot_get_ticket: (input) => {
    const contactId = syntheticId('dryrun-contact-');
    return {
      data: {
        found: true,
        ticket_id:
          String((input.params as Record<string, unknown>).ticket_id ?? '') ||
          syntheticId('dryrun-ticket-'),
        subject: '[dry-run] ticket',
        content: null,
        pipeline: null,
        pipeline_label: null,
        stage: null,
        stage_label: null,
        priority: null,
        created_at: null,
        updated_at: null,
        owner_id: null,
        owner_name: null,
        follow_up_user: null,
        follow_up_name: null,
        due_date: null,
        ticket_url: null,
        contacts: [
          {
            contact_id: contactId,
            email: 'dry@example.com',
            firstname: '[dry-run]',
            lastname: '[dry-run]',
          },
        ],
        companies: [
          {
            company_id: syntheticId('dryrun-company-'),
            name: '[dry-run] Co',
            domain: 'example.com',
            source: 'contact',
            via_contact_id: contactId,
          },
        ],
        error: null,
      },
      summary: '[dry-run] Would fetch HubSpot ticket with associations',
    };
  },
  hubspot_update_ticket: (input) => ({
    data: {
      ticket_id:
        String((input.params as Record<string, unknown>).ticket_id ?? '') ||
        syntheticId('dryrun-ticket-'),
      updated: true,
      updated_fields: [],
      ticket_url: null,
      owner_resolved: null,
      follow_up_resolved: null,
      due_date_set: null,
      warnings: [],
      error: null,
    },
    summary: '[dry-run] Would update HubSpot ticket properties',
  }),
  hubspot_list_objects: (input) => {
    const objectType = String((input.params as Record<string, unknown>).object_type ?? 'contacts');
    return {
      data: {
        object_type: objectType,
        objects: [
          { id: syntheticId('dryrun-obj-'), label: '[dry-run] record', properties: {}, url: null },
        ],
        count: 1,
        error: null,
      },
      summary: `[dry-run] Would list HubSpot ${objectType}`,
    };
  },
  hubspot_create_object: (input) => {
    const objectType = String((input.params as Record<string, unknown>).object_type ?? 'contacts');
    return {
      data: {
        object_type: objectType,
        id: syntheticId('dryrun-obj-'),
        created: true,
        url: null,
        error: null,
      },
      summary: `[dry-run] Would create HubSpot ${objectType.replace(/s$/, '')}`,
    };
  },
  hubspot_update_object: (input) => {
    const params = input.params as Record<string, unknown>;
    const objectType = String(params.object_type ?? 'contacts');
    return {
      data: {
        object_type: objectType,
        id: String(params.object_id ?? '') || syntheticId('dryrun-obj-'),
        updated: true,
        url: null,
        error: null,
      },
      summary: `[dry-run] Would update HubSpot ${objectType.replace(/s$/, '')}`,
    };
  },
  hubspot_delete_object: (input) => {
    const params = input.params as Record<string, unknown>;
    const objectType = String(params.object_type ?? 'contacts');
    return {
      data: {
        object_type: objectType,
        id: String(params.object_id ?? '') || syntheticId('dryrun-obj-'),
        deleted: true,
        error: null,
      },
      summary: `[dry-run] Would archive HubSpot ${objectType.replace(/s$/, '')}`,
    };
  },
  hubspot_list_lists: () => ({
    data: {
      lists: [
        {
          list_id: syntheticId('dryrun-list-'),
          name: '[dry-run] list',
          processing_type: 'MANUAL',
          size: 0,
        },
      ],
      count: 1,
      error: null,
    },
    summary: '[dry-run] Would list HubSpot lists',
  }),
  hubspot_create_list: (input) => ({
    data: {
      list_id: syntheticId('dryrun-list-'),
      created: true,
      error: null,
    },
    summary: `[dry-run] Would create HubSpot list "${String((input.params as Record<string, unknown>).name ?? '')}"`,
  }),
  hubspot_update_list: (input) => ({
    data: {
      list_id:
        String((input.params as Record<string, unknown>).list_id ?? '') ||
        syntheticId('dryrun-list-'),
      updated: true,
      error: null,
    },
    summary: '[dry-run] Would rename HubSpot list',
  }),
  hubspot_delete_list: (input) => ({
    data: {
      list_id:
        String((input.params as Record<string, unknown>).list_id ?? '') ||
        syntheticId('dryrun-list-'),
      deleted: true,
      error: null,
    },
    summary: '[dry-run] Would archive HubSpot list',
  }),
  hubspot_list_membership: (input) => {
    const params = input.params as Record<string, unknown>;
    const mode = String(params.mode ?? 'add').toLowerCase() === 'remove' ? 'remove' : 'add';
    return {
      data: {
        list_id: String(params.list_id ?? '') || syntheticId('dryrun-list-'),
        mode,
        updated: 1,
        error: null,
      },
      summary: `[dry-run] Would ${mode} HubSpot list members`,
    };
  },
  n8n_list_workflows: () => ({
    data: {
      count: 1,
      workflows: [
        {
          workflow_id: syntheticId('dryrun-wf-'),
          name: '[dry-run] workflow',
          active: false,
          updated_at: null,
          editor_url: 'http://127.0.0.1:0/workflow/dry-run',
        },
      ],
      error: null,
    },
    summary: '[dry-run] Would list n8n workflows',
  }),
  n8n_get_workflow: (input) => {
    const id =
      String((input.params as Record<string, unknown>).workflow_id ?? '') ||
      syntheticId('dryrun-wf-');
    return {
      data: {
        found: true,
        workflow_id: id,
        name: '[dry-run] workflow',
        active: false,
        workflow_json: { name: '[dry-run] workflow', nodes: [], connections: {}, settings: {} },
        editor_url: `http://127.0.0.1:0/workflow/${id}`,
        error: null,
      },
      summary: '[dry-run] Would fetch n8n workflow',
    };
  },
  n8n_create_workflow: () => {
    const id = syntheticId('dryrun-wf-');
    return {
      data: {
        created: true,
        workflow_id: id,
        name: '[dry-run] workflow',
        editor_url: `http://127.0.0.1:0/workflow/${id}`,
        error: null,
      },
      summary: '[dry-run] Would create n8n workflow',
    };
  },
  n8n_update_workflow: (input) => {
    const id =
      String((input.params as Record<string, unknown>).workflow_id ?? '') ||
      syntheticId('dryrun-wf-');
    return {
      data: {
        updated: true,
        workflow_id: id,
        name: '[dry-run] workflow',
        editor_url: `http://127.0.0.1:0/workflow/${id}`,
        error: null,
      },
      summary: '[dry-run] Would update n8n workflow',
    };
  },
  n8n_activate_workflow: (input) => ({
    data: {
      success: true,
      workflow_id:
        String((input.params as Record<string, unknown>).workflow_id ?? '') ||
        syntheticId('dryrun-wf-'),
      active: true,
      error: null,
    },
    summary: '[dry-run] Would activate n8n workflow',
  }),
  n8n_deactivate_workflow: (input) => ({
    data: {
      success: true,
      workflow_id:
        String((input.params as Record<string, unknown>).workflow_id ?? '') ||
        syntheticId('dryrun-wf-'),
      active: false,
      error: null,
    },
    summary: '[dry-run] Would deactivate n8n workflow',
  }),
  n8n_delete_workflow: (input) => ({
    data: {
      deleted: true,
      workflow_id:
        String((input.params as Record<string, unknown>).workflow_id ?? '') ||
        syntheticId('dryrun-wf-'),
      error: null,
    },
    summary: '[dry-run] Would delete n8n workflow (permanent in a real run)',
  }),
  n8n_run_workflow: (input) => ({
    data: {
      started: true,
      workflow_id:
        String((input.params as Record<string, unknown>).workflow_id ?? '') ||
        syntheticId('dryrun-wf-'),
      execution_id: syntheticId('dryrun-exec-'),
      status: 'success',
      error: null,
    },
    summary: '[dry-run] Would run n8n workflow',
  }),
  n8n_list_executions: () => ({
    data: {
      count: 1,
      executions: [
        {
          execution_id: syntheticId('dryrun-exec-'),
          workflow_id: syntheticId('dryrun-wf-'),
          status: 'success',
          started_at: null,
          stopped_at: null,
        },
      ],
      error: null,
    },
    summary: '[dry-run] Would list n8n executions',
  }),
  n8n_get_execution: (input) => ({
    data: {
      found: true,
      execution_id:
        String((input.params as Record<string, unknown>).execution_id ?? '') ||
        syntheticId('dryrun-exec-'),
      workflow_id: syntheticId('dryrun-wf-'),
      workflow_name: '[dry-run] workflow',
      status: 'success',
      started_at: null,
      stopped_at: null,
      failed_node: null,
      error_message: null,
      last_node_executed: null,
      error: null,
    },
    summary: '[dry-run] Would fetch n8n execution',
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
  send_slack_message: (input) => ({
    data: {
      sent: true,
      message_ts: '0000.000000',
      channel: String((input.params as Record<string, unknown>).channel ?? ''),
      error: null,
    },
    summary: '[dry-run] Would send Slack message',
  }),
  send_slack_file: (input) => ({
    data: {
      sent: true,
      file_id: syntheticId('dryrun-slackfile-'),
      channel: String((input.params as Record<string, unknown>).channel ?? ''),
      error: null,
    },
    summary: '[dry-run] Would upload Slack file',
  }),
  list_slack_channels: () => ({
    data: { ok: true, channels: [], error: null },
    summary: '[dry-run] Would list Slack channels',
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
    data: {
      response: '[dry-run] simulated LLM response',
      result: '[dry-run] simulated LLM response',
    },
    summary: '[dry-run] Would ask the model',
  }),
  model_call: () => ({
    data: {
      response: '[dry-run] simulated LLM response',
      result: '[dry-run] simulated LLM response',
    },
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
    data: {
      response: '[dry-run] simulated expert response',
      result: '[dry-run] simulated expert response',
    },
    summary: '[dry-run] Would invoke an expert',
  }),
  expert_step: () => ({
    data: {
      response: '[dry-run] simulated expert response',
      result: '[dry-run] simulated expert response',
    },
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

  // Calendar — never touch the real provider in a dry run.
  calendar_create_event: () => ({
    data: { created: true, error: null },
    summary: '[dry-run] Would create calendar event',
  }),
  calendar_update_event: () => ({
    data: { updated: true, error: null },
    summary: '[dry-run] Would update calendar event',
  }),
  calendar_delete_event: () => ({
    data: { deleted: true, error: null },
    summary: '[dry-run] Would delete calendar event',
  }),
  calendar_rsvp: () => ({
    data: { ok: true, error: null },
    summary: '[dry-run] Would RSVP to calendar event',
  }),
  calendar_query_events: () => ({
    data: { count: 0, events: [] },
    summary: '[dry-run] Would read calendar events',
  }),
  calendar_find_free_time: () => ({
    data: { slots: [], count: 0 },
    summary: '[dry-run] Would find free time',
  }),

  // Gmail — reads return empty results; writes echo the would-be effect.
  gmail_search_messages: (input) => {
    const params = input.params as Record<string, unknown>;
    return {
      data: { count: 0, messages: [] },
      summary: `[dry-run] Would search email for "${String(params.query ?? '')}"`,
    };
  },
  gmail_get_thread: () => ({
    data: { thread_id: 'dry-run-thread', subject: '', message_count: 0, messages: [] },
    summary: '[dry-run] Would read an email thread',
  }),
  gmail_list_labels: () => ({
    data: { count: 0, labels: [] },
    summary: '[dry-run] Would list Gmail labels',
  }),
  gmail_get_contact_history: (input) => {
    const params = input.params as Record<string, unknown>;
    return {
      data: { count: 0, threads: [] },
      summary: `[dry-run] Would look up email history with ${String(params.email ?? '?')}`,
    };
  },
  gmail_send_message: (input) => {
    const params = input.params as Record<string, unknown>;
    return {
      data: { sent: true, message_id: 'dry-run-message', thread_id: null, error: null },
      summary: `[dry-run] Would send "${String(params.subject ?? '')}" to ${String(params.to ?? '?')}`,
    };
  },
  gmail_create_draft: (input) => {
    const params = input.params as Record<string, unknown>;
    return {
      data: { created: true, draft_id: 'dry-run-draft', error: null },
      summary: `[dry-run] Would save a draft for ${String(params.to ?? '?')}`,
    };
  },
  gmail_modify_labels: () => ({
    data: { modified: 0, error: null },
    summary: '[dry-run] Would modify Gmail labels',
  }),
  gmail_list_awaiting_reply: () => ({
    data: { count: 0, threads: [] },
    summary: '[dry-run] Would list threads awaiting a reply',
  }),
  gmail_log_to_hubspot: (input) => {
    const params = input.params as Record<string, unknown>;
    return {
      data: { logged: true, contact_id: 'dry-run-contact', note_id: 'dry-run-note', warnings: [] },
      summary: `[dry-run] Would log thread ${String(params.thread_id ?? '?')} to HubSpot`,
    };
  },

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
