/**
 * Builds a system-prompt prefix that tells an expert running as part of a
 * routine where it sits in the DAG: what already ran, what will run after,
 * and what each downstream action will actually *do* with the expert's
 * output. Without this, an LLM running as step 1 of a routine has zero
 * awareness that step 2 will create a HubSpot ticket using its output —
 * so it tries to "create the ticket" itself, asks the user for an API
 * token, and the routine looks broken.
 *
 * Returned string is empty for trivial cases (single-step routines, the
 * step has no upstream/downstream peers). Otherwise it's an
 * action-aware narrative the agent reads at the top of its prompt.
 */

import type { DAGDefinition, StepDefinition } from '../dag/types';
import { resolveActionType } from '../../utils/step-defaults';

interface ActionDescription {
  /** Short, agent-readable sentence describing what this step will do. */
  description: string;
  /** Optional hint about what it expects from upstream output, in plain text. */
  expects?: string;
}

/**
 * Per-action descriptions shown to the expert. The "expects" field is the
 * key UX leverage — telling the expert "produce a subject and body" maps
 * its strength (writing) onto exactly what the next step needs, instead
 * of leaving it to invent its own behaviour.
 *
 * When adding a new action type to the engine, ALSO add an entry here so
 * experts running upstream of it understand what to produce.
 */
const ACTION_DESCRIPTIONS: Record<string, ActionDescription> = {
  hubspot_create_ticket: {
    description:
      'Creates a HubSpot ticket via the HubSpot API. The HubSpot integration is connected at the platform level — the next step calls HubSpot directly, you do NOT need to ask for an API token or attempt the call yourself.',
    expects: "the ticket's subject and body content as plain text",
  },
  hubspot_upsert_contact: {
    description:
      'Creates or updates a HubSpot contact via the HubSpot API. The integration is wired automatically.',
    expects: 'an email address and any optional fields (first/last name, phone)',
  },
  send_telegram_message: {
    description: 'Sends a Telegram message via the connected bot.',
    expects: 'the message body in plain text or Markdown',
  },
  send_whatsapp_message: {
    description: 'Sends a WhatsApp message via the connected number.',
    expects: 'the message body in plain text',
  },
  send_email: {
    description: 'Sends an email via the connected provider.',
    expects: 'the email subject and body',
  },
  send_message: {
    description: 'Posts a message into the Cerebro chat.',
    expects: 'the message text',
  },
  send_notification: {
    description: 'Shows a desktop notification on the user\'s machine.',
    expects: 'a short headline (and optional body)',
  },
  http_request: {
    description: 'Performs an HTTP request to a configured endpoint.',
    expects: 'the request body if applicable',
  },
  ask_ai: {
    description: 'Runs a one-shot LLM call with a configured prompt.',
  },
  run_expert: {
    description: 'Runs another expert agent with a configured prompt.',
  },
  classify: {
    description: 'Classifies its input into one of a fixed set of categories.',
  },
  extract: {
    description: 'Extracts structured fields from its input.',
  },
  summarize: {
    description: 'Summarizes its input.',
  },
  search_memory: {
    description: 'Searches Cerebro memory for relevant context.',
  },
  search_web: {
    description: 'Searches the web for relevant information.',
  },
  search_documents: {
    description: 'Searches a configured document bucket.',
  },
  save_to_memory: {
    description: 'Saves its input into Cerebro memory.',
  },
  run_command: {
    description: 'Runs a configured shell command.',
  },
  run_claude_code: {
    description: 'Runs a Claude Code subprocess for code-modification work.',
  },
  approval_gate: {
    description: 'Pauses the run until a human approves.',
  },
  delay: {
    description: 'Waits a configured duration.',
  },
  condition: {
    description: 'Branches the run based on a configured condition.',
  },
  loop: {
    description: 'Loops over its input items.',
  },
  webhook_response: {
    description: 'Replies to the inbound webhook caller.',
  },
};

function describeAction(step: StepDefinition): ActionDescription {
  const resolved = resolveActionType(step.actionType);
  return (
    ACTION_DESCRIPTIONS[resolved] ?? {
      description: `Runs a ${resolved.replace(/_/g, ' ')} action.`,
    }
  );
}

/**
 * Returns the steps that consume this step's output (either via explicit
 * input mappings or a `dependsOn` edge).
 */
function downstreamSteps(dag: DAGDefinition, stepId: string): StepDefinition[] {
  return dag.steps.filter((s) => {
    const wired = (s.inputMappings ?? []).some((m) => m.sourceStepId === stepId);
    const depended = (s.dependsOn ?? []).includes(stepId);
    return wired || depended;
  });
}

/**
 * Returns the steps whose output flows into this step.
 */
function upstreamSteps(dag: DAGDefinition, stepId: string): StepDefinition[] {
  const step = dag.steps.find((s) => s.id === stepId);
  if (!step) return [];
  const upstreamIds = new Set<string>();
  for (const m of step.inputMappings ?? []) upstreamIds.add(m.sourceStepId);
  for (const d of step.dependsOn ?? []) upstreamIds.add(d);
  return dag.steps.filter((s) => upstreamIds.has(s.id));
}

/**
 * Build the routine-context block. Returns '' when there's nothing useful
 * to say (single-step routine, step is isolated in the DAG, etc.).
 */
export function buildRoutineContext(dag: DAGDefinition, stepId: string): string {
  if (!dag?.steps || dag.steps.length <= 1) return '';

  const downstream = downstreamSteps(dag, stepId);
  const upstream = upstreamSteps(dag, stepId);
  if (downstream.length === 0 && upstream.length === 0) return '';

  const lines: string[] = [];
  lines.push('## Workflow context');
  lines.push(
    'You are running as one step of a multi-step routine. Other steps run before and after you and handle their own concerns. Focus on producing the deliverable that downstream steps need — do NOT attempt to perform actions that those steps will do automatically (calling external APIs, sending messages, creating tickets, etc.). Do NOT ask the user for credentials for integrations that downstream steps already have.',
  );

  if (upstream.length > 0) {
    lines.push('', '### Upstream steps that already produced your inputs');
    for (const us of upstream) {
      const meta = describeAction(us);
      lines.push(`- "${us.name}" — ${meta.description}`);
    }
  }

  if (downstream.length > 0) {
    lines.push('', '### Downstream steps that will run AFTER you');
    for (const ds of downstream) {
      const meta = describeAction(ds);
      const expectsLine = meta.expects ? `\n  → They expect from your output: ${meta.expects}.` : '';
      lines.push(`- "${ds.name}" — ${meta.description}${expectsLine}`);
    }
  }

  lines.push('', '---', '');
  return lines.join('\n');
}
