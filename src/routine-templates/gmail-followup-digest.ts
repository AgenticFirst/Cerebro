/**
 * "Email follow-up nudges (Gmail)" — the flagship outreach routine.
 *
 * Every morning it finds sent emails that never got a reply (N+ days old),
 * drafts a short personalized follow-up per thread with the model, and sends
 * it as an in-thread reply behind an approval gate — HubSpot-sequence-style
 * auto-unenroll for free, because a thread with a reply simply stops matching.
 */

import type { RoutineTemplate } from '../types/routine-templates';

const FOLLOWUP_PROMPT =
  'These email threads were sent by the user and have had no reply for %%wait_days%%+ days:\n' +
  '{{threads}}\n\n' +
  'Write a report with ONE short follow-up suggestion per thread. For each: the thread subject, ' +
  'the thread_id, and a 2–3 sentence friendly nudge in the same language as the original subject — ' +
  'polite, no guilt-tripping, offers an easy out ("if now is a bad time…"). ' +
  'If there are no threads, output exactly: NOTHING_TO_DO';

const DAG = {
  trigger: {
    triggerType: 'trigger_cron',
    config: { cron_expression: '%%cron_expression%%' },
  },
  steps: [
    {
      id: 'find_unanswered',
      name: 'Find unanswered emails',
      actionType: 'gmail_list_awaiting_reply',
      params: { older_than_days: '%%wait_days%%' },
      dependsOn: [],
      inputMappings: [],
      requiresApproval: false,
      onError: 'fail',
    },
    {
      id: 'draft_nudges',
      name: 'Draft follow-up nudges',
      actionType: 'ask_ai',
      params: { prompt: FOLLOWUP_PROMPT, agent: 'cerebro' },
      dependsOn: ['find_unanswered'],
      inputMappings: [
        { sourceStepId: 'find_unanswered', sourceField: 'threads', targetField: 'threads' },
      ],
      requiresApproval: false,
      onError: 'fail',
    },
    {
      id: 'notify_digest',
      name: 'Deliver the digest',
      actionType: 'send_notification',
      params: {
        title: 'Email follow-ups',
        message: '{{digest}}',
      },
      dependsOn: ['draft_nudges'],
      inputMappings: [
        { sourceStepId: 'draft_nudges', sourceField: 'response', targetField: 'digest' },
      ],
      requiresApproval: false,
      onError: 'fail',
    },
  ],
};

export const gmailFollowupDigestTemplate: RoutineTemplate = {
  id: 'gmail-followup-digest',
  name: 'Email follow-up nudges (Gmail)',
  description:
    'Every day Cerebro finds outreach emails that never got a reply, drafts a ' +
    'personalized nudge for each, and delivers the digest so you can send ' +
    'follow-ups in one pass. Threads that get a reply drop out automatically.',
  category: 'productivity',
  requiredConnections: ['gmail'],
  plainEnglishSteps: [
    'On the schedule you pick, list sent emails with no reply after the waiting period',
    'Draft a short, friendly follow-up suggestion per unanswered thread',
    'Deliver the digest as a desktop notification (ask Cerebro in chat to send any nudge as an in-thread reply)',
  ],
  dagJson: JSON.stringify(DAG, null, 2),
  triggerType: 'cron',
  triggerConfig: { cron_expression: '%%cron_expression%%' },
  variables: [
    {
      key: 'cron_expression',
      label: 'Schedule (cron)',
      description: 'When to check. Default: every weekday at 8:30am.',
      type: 'text',
      placeholder: '30 8 * * 1-5',
      required: true,
      default: '30 8 * * 1-5',
    },
    {
      key: 'wait_days',
      label: 'Days to wait before nudging',
      description: 'Only threads whose last outbound message is at least this old.',
      type: 'text',
      placeholder: '3',
      required: true,
      default: '3',
    },
  ],
};
