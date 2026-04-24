/**
 * "Customer Support via WhatsApp (HubSpot tickets)" — Cerebro's first
 * marketplace routine template.
 *
 * Flow: customer DMs the business's WhatsApp number → this routine runs
 * per-message, classifies the conversation state, either keeps gathering
 * info OR opens a HubSpot ticket and confirms.
 *
 * Each message triggers a fresh run; the LLM reads conversation history
 * from the trigger payload so the routine is stateless across runs and
 * scales to many concurrent customers for free.
 */

import type { RoutineTemplate } from '../types/routine-templates';

// ── DAG construction ─────────────────────────────────────────────
//
// Placeholders use %%var%% syntax so they don't collide with Mustache {{...}}
// expressions the routine itself renders at run time.

interface InputMapping {
  sourceStepId: string;
  sourceField: string;
  targetField: string;
  branchCondition?: 'true' | 'false';
}

interface Step {
  id: string;
  name: string;
  actionType: string;
  params: Record<string, unknown>;
  dependsOn: string[];
  inputMappings: InputMapping[];
  requiresApproval: boolean;
  onError: 'fail' | 'skip' | 'retry';
  maxRetries?: number;
  timeoutMs?: number;
}

/** Build a step with defaults + a compact mappings DSL. Each entry in `wire`
 *  is `"sourceStepId.sourceField -> targetField"` (no branch condition) or
 *  `"sourceStepId.sourceField -> targetField @true"` / `"@false"` to gate on
 *  an upstream condition's branch. dependsOn is derived from the mappings. */
function step(cfg: {
  id: string;
  name: string;
  actionType: string;
  params: Record<string, unknown>;
  wire: string[];
  extraDepends?: string[];
  onError?: Step['onError'];
}): Step {
  const inputMappings: InputMapping[] = cfg.wire.map((entry) => {
    const [body, branch] = entry.split('@').map((s) => s.trim());
    const [left, right] = body.split('->').map((s) => s.trim());
    const [sourceStepId, ...rest] = left.split('.');
    const sourceField = rest.join('.');
    const mapping: InputMapping = { sourceStepId, sourceField, targetField: right };
    if (branch === 'true' || branch === 'false') mapping.branchCondition = branch;
    return mapping;
  });
  const deps = new Set<string>([...(cfg.extraDepends ?? []), ...inputMappings.map((m) => m.sourceStepId)]);
  return {
    id: cfg.id,
    name: cfg.name,
    actionType: cfg.actionType,
    params: cfg.params,
    dependsOn: Array.from(deps),
    inputMappings,
    requiresApproval: false,
    onError: cfg.onError ?? 'fail',
  };
}

const CLASSIFY_PROMPT =
  'You are a conversation-state classifier for a customer-support chat.\n\n' +
  'Conversation history (oldest first):\n{{conversation_history}}\n\n' +
  'Latest customer message: "{{latest_message}}"\n\n' +
  'Choose the category that best describes the CURRENT state of the thread:\n' +
  '- greeting: the customer just said hello or hi with no substance yet.\n' +
  '- awaiting_name: we greeted them but do not yet know their name.\n' +
  '- awaiting_issue: we know the name, but the customer has not described a problem.\n' +
  '- gathering_details: the customer described a problem but we need more detail to open a useful ticket.\n' +
  '- ready_for_ticket: we have a clear problem description with enough detail to open a ticket.\n' +
  '- off_topic: the message is not a support request (sales pitch, spam, unrelated).';

const EXTRACT_PROMPT =
  'Conversation history:\n{{conversation_history}}\n\n' +
  'Latest message: "{{latest_message}}"\n\n' +
  'Extract whatever you can from the conversation so far. Use null for anything the customer has not actually said yet — do not guess.';

const CONFIRMATION_SYSTEM =
  'You are %%bot_name%%, a customer-support agent at %%company_name%%. Tone: %%bot_tone%%. ' +
  'Match the customer\'s language exactly. A support ticket was just created for this customer. ' +
  'Write a short, warm confirmation under 60 words that: (a) thanks them by name if you know it, ' +
  '(b) mentions the ticket id, (c) sets expectations that a human teammate will follow up. ' +
  'Never promise a specific response time.';

const GATHERING_SYSTEM =
  'You are %%bot_name%%, a customer-support agent at %%company_name%%. Tone: %%bot_tone%%. ' +
  'Always match the customer\'s language. You are in the middle of gathering info so you can open a support ticket. ' +
  'Current conversation state: {{state}}. Use that to decide what to say next:\n' +
  '- greeting: introduce yourself briefly as %%bot_name%%, ask the customer\'s name.\n' +
  '- awaiting_name: thank them by name, ask how you can help.\n' +
  '- awaiting_issue: ask them to describe the problem in their own words.\n' +
  '- gathering_details: ask the SINGLE most useful follow-up question to reach enough detail ' +
  '  for a ticket (error messages, affected product, when it started). Never ask more than one thing.\n' +
  '- off_topic: politely redirect back to support.\n' +
  'Under 50 words. Never promise a timeline or a specific person.';

const STEPS: Step[] = [
  step({
    id: 'classify_state', name: 'Classify conversation state', actionType: 'classify',
    params: {
      prompt: CLASSIFY_PROMPT,
      categories: ['greeting', 'awaiting_name', 'awaiting_issue', 'gathering_details', 'ready_for_ticket', 'off_topic'],
      agent: 'cerebro',
    },
    wire: [
      '__trigger__.conversation_history -> conversation_history',
      '__trigger__.message_text -> latest_message',
    ],
  }),
  step({
    id: 'extract_fields', name: 'Extract customer info', actionType: 'extract',
    params: {
      prompt: EXTRACT_PROMPT,
      schema: [
        { name: 'customer_name', type: 'string', description: 'The customer\'s first name or preferred name. null if not stated.' },
        { name: 'customer_email', type: 'string', description: 'Customer email if mentioned. null otherwise.' },
        { name: 'issue_summary', type: 'string', description: 'One-sentence summary of the customer\'s problem. null if unknown.' },
        { name: 'issue_category', type: 'string', description: 'Best-guess category (billing, technical, access, general_inquiry, other). null if unclear.' },
        { name: 'urgency', type: 'string', description: 'One of LOW, MEDIUM, HIGH based on how blocked the customer is. null if unclear.' },
      ],
      agent: 'cerebro',
    },
    wire: [
      '__trigger__.conversation_history -> conversation_history',
      '__trigger__.message_text -> latest_message',
    ],
  }),
  step({
    id: 'is_ready', name: 'Ready to open ticket?', actionType: 'condition',
    params: { field: 'category', operator: 'equals', value: 'ready_for_ticket' },
    wire: ['classify_state.category -> category'],
  }),
  step({
    id: 'upsert_contact', name: 'HubSpot: Upsert contact', actionType: 'hubspot_upsert_contact',
    params: {
      email: '{{email}}', phone: '{{phone}}', firstname: '{{firstname}}', lifecyclestage: 'customer',
    },
    wire: [
      'is_ready.branch -> _gate @true',
      'extract_fields.customer_email -> email',
      'extract_fields.customer_name -> firstname',
      '__trigger__.phone_number -> phone',
    ],
  }),
  step({
    id: 'create_ticket', name: 'HubSpot: Create ticket', actionType: 'hubspot_create_ticket',
    params: {
      subject: '{{subject}}',
      content:
        'From %%bot_name%% — %%company_name%% WhatsApp support.\n\n' +
        'Customer: {{customer_name}}\nPhone: {{phone_number}}\n\n' +
        'Issue summary: {{issue_summary}}\nCategory: {{issue_category}}',
      pipeline: '%%hubspot_pipeline%%',
      stage: '%%hubspot_stage%%',
      priority: '{{priority}}',
      contact_id: '{{contact_id}}',
    },
    wire: [
      'upsert_contact.contact_id -> contact_id',
      'extract_fields.issue_summary -> subject',
      'extract_fields.issue_summary -> issue_summary',
      'extract_fields.issue_category -> issue_category',
      'extract_fields.customer_name -> customer_name',
      'extract_fields.urgency -> priority',
      '__trigger__.phone_number -> phone_number',
    ],
  }),
  step({
    id: 'save_ticket_summary', name: 'Save ticket snapshot to memory', actionType: 'save_to_memory',
    params: {
      content:
        'WhatsApp ticket opened.\n' +
        'Ticket id: {{ticket_id}}\nTicket URL: {{ticket_url}}\n' +
        'Customer: {{customer_name}}\nPhone: {{phone_number}}\n' +
        'Issue: {{issue_summary}}',
      agent: 'cerebro', mode: 'write', topic: 'Support ticket {{ticket_id}}',
    },
    wire: [
      'create_ticket.ticket_id -> ticket_id',
      'create_ticket.ticket_url -> ticket_url',
      'extract_fields.customer_name -> customer_name',
      'extract_fields.issue_summary -> issue_summary',
      '__trigger__.phone_number -> phone_number',
    ],
    onError: 'skip',
  }),
  step({
    id: 'compose_confirmation', name: 'Compose confirmation reply', actionType: 'ask_ai',
    params: {
      system_prompt: CONFIRMATION_SYSTEM,
      prompt:
        'Customer: {{customer_name}}\nIssue: {{issue_summary}}\nTicket id: {{ticket_id}}\n\n' +
        'Write the confirmation message now. Reply only with the message body, no greeting header.',
      agent: 'cerebro',
    },
    wire: [
      'create_ticket.ticket_id -> ticket_id',
      'extract_fields.customer_name -> customer_name',
      'extract_fields.issue_summary -> issue_summary',
    ],
  }),
  step({
    id: 'send_confirmation', name: 'Send WhatsApp confirmation', actionType: 'send_whatsapp_message',
    params: { phone_number: '{{phone_number}}', message: '{{response}}' },
    wire: [
      '__trigger__.phone_number -> phone_number',
      'compose_confirmation.response -> response',
    ],
  }),
  step({
    id: 'compose_next_message', name: 'Compose next gathering reply', actionType: 'ask_ai',
    params: {
      system_prompt: GATHERING_SYSTEM,
      prompt:
        'Conversation history:\n{{conversation_history}}\n\n' +
        'Latest customer message: "{{latest_message}}"\n\n' +
        'What we already know:\nname={{customer_name}}, email={{customer_email}}, issue={{issue_summary}}\n\n' +
        'Write the next reply now. Reply only with the message body.',
      agent: 'cerebro',
    },
    wire: [
      'is_ready.branch -> _gate @false',
      'classify_state.category -> state',
      'extract_fields.customer_name -> customer_name',
      'extract_fields.customer_email -> customer_email',
      'extract_fields.issue_summary -> issue_summary',
      '__trigger__.conversation_history -> conversation_history',
      '__trigger__.message_text -> latest_message',
    ],
  }),
  step({
    id: 'send_next_message', name: 'Send WhatsApp reply', actionType: 'send_whatsapp_message',
    params: { phone_number: '{{phone_number}}', message: '{{response}}' },
    wire: [
      '__trigger__.phone_number -> phone_number',
      'compose_next_message.response -> response',
    ],
  }),
];

const DAG = {
  trigger: {
    triggerType: 'trigger_whatsapp_message',
    config: {
      phone_number: '*',
      filter_type: 'none',
      filter_value: '',
    },
  },
  steps: STEPS,
};

// ── Template metadata ────────────────────────────────────────────

export const customerSupportWhatsAppHubSpotTemplate: RoutineTemplate = {
  id: 'customer-support-whatsapp-hubspot',
  name: 'Customer Support via WhatsApp (HubSpot tickets)',
  description:
    "When a customer messages your WhatsApp Business number, %%bot_name%% greets them, " +
    'asks for their name and issue, and opens a HubSpot ticket once enough detail is gathered.',
  category: 'customer_support',
  requiredConnections: ['whatsapp', 'hubspot'],
  plainEnglishSteps: [
    'A customer sends a WhatsApp message to your paired business number',
    '%%bot_name%% classifies the conversation state (greeting, gathering info, or ready for a ticket)',
    'If information is still missing, %%bot_name%% asks the next most-useful question',
    'Once the issue is clear, a HubSpot contact is upserted and a ticket is opened in %%company_name%%\'s configured pipeline',
    '%%bot_name%% confirms the ticket id back to the customer on WhatsApp',
    'The ticket snapshot is saved to memory for future agent look-ups',
  ],
  dagJson: JSON.stringify(DAG, null, 2),
  triggerType: 'whatsapp_message',
  triggerConfig: {
    phone_number: '*',
    filter_type: 'none',
    filter_value: '',
  },
  variables: [
    {
      key: 'company_name',
      label: 'Company name',
      description: 'How the bot should refer to your company.',
      type: 'text',
      placeholder: 'Acme Widgets',
      required: true,
    },
    {
      key: 'bot_name',
      label: 'Bot name',
      description: 'The persona name the bot introduces itself with.',
      type: 'text',
      placeholder: 'Juan',
      required: true,
      default: 'Juan',
    },
    {
      key: 'bot_tone',
      label: 'Tone',
      description: 'Tone guidance injected into the bot\'s system prompt.',
      type: 'textarea',
      required: false,
      default: 'warm, concise, professional',
    },
    {
      key: 'hubspot_pipeline',
      label: 'HubSpot ticket pipeline',
      description: 'Which pipeline new tickets should be created in.',
      type: 'hubspot_pipeline',
      required: true,
    },
    {
      key: 'hubspot_stage',
      label: 'HubSpot ticket stage',
      description: 'Starting stage for newly opened tickets.',
      type: 'hubspot_stage',
      required: true,
      dependsOnVariable: 'hubspot_pipeline',
    },
  ],
};
