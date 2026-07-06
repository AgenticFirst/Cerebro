/**
 * Gmail-trigger routine parsing + matching (mirrors the slack_message trigger
 * in src/slack/helpers.ts).
 *
 * A routine with trigger_type='gmail_message' stores its filter in the DAG's
 * trigger config: optional `from` (address or @domain, '*' = anyone) and
 * optional `subject_contains`. The trigger payload exposed to steps as
 * {{__trigger__.<field>}}: from, to, subject, snippet, thread_id, message_id,
 * received_at.
 */

import type { DAGDefinition } from '../engine/dag/types';
import type { GmailMessageSummary } from './types';

interface CanvasDagJson extends DAGDefinition {
  trigger?: {
    triggerType?: string;
    config?: Record<string, unknown>;
  };
}

export interface GmailTriggerConfig {
  /** Sender filter: full address, '@domain.com' suffix, or '*' for anyone. */
  from: string;
  /** Optional case-insensitive substring the subject must contain. */
  subject_contains?: string;
}

export interface GmailTriggerRoutine {
  id: string;
  name: string;
  dag: DAGDefinition;
  trigger: GmailTriggerConfig;
}

export interface BackendRoutineRecord {
  id: string;
  name: string;
  is_enabled: boolean;
  trigger_type: string;
  dag_json: string | null;
}

export function parseGmailTriggerRoutine(record: BackendRoutineRecord): GmailTriggerRoutine | null {
  if (!record.dag_json) return null;
  let dag: CanvasDagJson;
  try {
    dag = JSON.parse(record.dag_json) as CanvasDagJson;
  } catch {
    return null;
  }
  if (dag.trigger?.triggerType !== 'trigger_gmail_message') return null;
  const cfg = dag.trigger?.config ?? {};
  const from = typeof cfg.from === 'string' && cfg.from.trim() ? cfg.from.trim() : '*';
  const subject_contains =
    typeof cfg.subject_contains === 'string' && cfg.subject_contains.trim()
      ? cfg.subject_contains.trim()
      : undefined;
  return {
    id: record.id,
    name: record.name,
    dag: { steps: dag.steps ?? [] },
    trigger: { from, subject_contains },
  };
}

/** Bare address from a "Display Name <addr@x.com>" header, case preserved. */
export function headerAddress(header: string): string {
  const m = header.match(/<([^>]+)>/);
  return (m ? m[1] : header).trim();
}

/** Lowercased header address — for matching/comparison, not display. */
export function extractAddress(fromHeader: string): string {
  return headerAddress(fromHeader).toLowerCase();
}

/** Split a comma/semicolon-separated recipient list into trimmed addresses. */
export function splitAddresses(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function matchesGmailTrigger(
  trigger: GmailTriggerConfig,
  msg: GmailMessageSummary,
): boolean {
  const sender = extractAddress(msg.from);
  if (trigger.from !== '*') {
    const want = trigger.from.toLowerCase();
    const matches = want.startsWith('@') ? sender.endsWith(want) : sender === want;
    if (!matches) return false;
  }
  if (trigger.subject_contains) {
    if (!msg.subject.toLowerCase().includes(trigger.subject_contains.toLowerCase())) return false;
  }
  return true;
}

export function buildGmailTriggerPayload(msg: GmailMessageSummary): Record<string, unknown> {
  return {
    from: msg.from,
    from_address: extractAddress(msg.from),
    to: msg.to,
    subject: msg.subject,
    snippet: msg.snippet,
    thread_id: msg.threadId,
    message_id: msg.id,
    received_at: msg.receivedAt,
  };
}
