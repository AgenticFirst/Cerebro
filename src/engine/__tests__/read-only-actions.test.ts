/**
 * Audit / lockdown test for the read-only approval-bypass surface.
 *
 * Read-only chat actions skip the approval gate in runChatAction (see
 * src/engine/engine.ts). That is a deliberate, narrow trust decision: marking a
 * *write* action `readOnly: true` would let it run with NO human approval and NO
 * prompt — a silent security regression. This test pins the exact set of
 * read-only chat actions so any drift (a new read added without the flag, or a
 * write/send accidentally marked read-only) fails loudly and forces a human to
 * re-confirm the decision.
 *
 * The audit runs against `getChatActionCatalog()` — the public catalog includes
 * every chat-exposable action regardless of connection state, so no channels
 * need to be wired up.
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { ExecutionEngine } from '../engine';

function makeEngine() {
  // Port is never dialed: the catalog is assembled purely in-process.
  return new ExecutionEngine(1, { startRun: vi.fn() } as any, new EventEmitter());
}

/**
 * The complete, intended set of read-only chat actions. Every entry has been
 * verified to ONLY read/query — no create, update, delete, or send. Adding to
 * this list is a security-relevant decision: the action will run with no
 * approval gate. Keep it in sync deliberately, never to "make the test pass".
 */
const EXPECTED_READONLY = new Set([
  'hubspot_search_contact',
  'hubspot_search_tickets',
  'hubspot_get_ticket',
  'hubspot_list_objects',
  'hubspot_list_lists',
  'list_slack_channels',
  'calendar_query_events',
  'calendar_find_free_time',
  // n8n reads — pure GETs against the local instance's /api/v1.
  'n8n_list_workflows',
  'n8n_get_workflow',
  'n8n_list_executions',
  'n8n_get_execution',
  // Gmail reads — local-store/Gmail GET lookups only; sends, drafts, and
  // label changes are separate always-gated actions.
  'gmail_search_messages',
  'gmail_get_thread',
  'gmail_list_labels',
  'gmail_get_contact_history',
  'gmail_list_awaiting_reply',
]);

/**
 * Actions that MUST always gate — representative writes/sends across every
 * integration. A regression that flips any of these to read-only is the exact
 * failure mode this suite exists to catch.
 */
const MUST_GATE = [
  'send_slack_message',
  'send_slack_file',
  'send_telegram_message',
  'send_whatsapp_message',
  'hubspot_create_ticket',
  'hubspot_update_ticket',
  'hubspot_upsert_contact',
  'hubspot_create_object',
  'hubspot_update_object',
  'hubspot_delete_object',
  'hubspot_create_list',
  'hubspot_update_list',
  'hubspot_delete_list',
  // Despite the "list" in its name this ADDS/REMOVES members — it is a write.
  'hubspot_list_membership',
  'github_create_issue',
  'github_open_pr',
  'calendar_create_event',
  'calendar_delete_event',
  // Real email leaves the account; drafts/labels mutate mailbox state.
  'gmail_send_message',
  'gmail_create_draft',
  'gmail_modify_labels',
  'gmail_log_to_hubspot',
  'n8n_create_workflow',
  'n8n_update_workflow',
  'n8n_activate_workflow',
  'n8n_deactivate_workflow',
  'n8n_run_workflow',
  'n8n_delete_workflow',
];

describe('read-only chat-action surface (approval-bypass lockdown)', () => {
  it('the set of read-only actions exactly matches the intended allowlist', () => {
    const catalog = makeEngine().getChatActionCatalog('en');
    const actual = new Set(catalog.filter((a) => a.readOnly).map((a) => a.type));

    const unexpected = [...actual].filter((t) => !EXPECTED_READONLY.has(t));
    const missing = [...EXPECTED_READONLY].filter((t) => !actual.has(t));

    // Spelled out so a failure names the offending action(s) directly.
    expect(
      unexpected,
      `Action(s) marked read-only but NOT in the reviewed allowlist — these would ` +
        `bypass approval with no prompt. Confirm they are truly side-effect-free, ` +
        `then add to EXPECTED_READONLY: ${unexpected.join(', ')}`,
    ).toEqual([]);
    expect(
      missing,
      `Expected read-only action(s) missing the flag (they will needlessly gate): ${missing.join(', ')}`,
    ).toEqual([]);

    expect(actual).toEqual(EXPECTED_READONLY);
  });

  it('every known write/send action still gates (readOnly === false)', () => {
    const catalog = makeEngine().getChatActionCatalog('en');
    const byType = new Map(catalog.map((a) => [a.type, a]));

    for (const type of MUST_GATE) {
      const entry = byType.get(type);
      // Guard against the action being renamed/removed without updating this list.
      expect(entry, `Expected chat action "${type}" to exist in the catalog`).toBeDefined();
      expect(entry!.readOnly, `Action "${type}" is a write/send and must NOT be read-only`).toBe(
        false,
      );
    }
  });

  it('defaults to gated: an action without the flag is not read-only', () => {
    // The contract is fail-safe — `readOnly` is opt-in. Anything that forgets to
    // set it is treated as a write and gates. Assert via a representative action.
    const catalog = makeEngine().getChatActionCatalog('en');
    const createTicket = catalog.find((a) => a.type === 'hubspot_create_ticket');
    expect(createTicket?.readOnly).toBe(false);
  });
});
