/**
 * "GitHub PR Review Requested → AI Code Review" template.
 *
 * Trigger: someone requests the connected user as a reviewer on a PR.
 * Flow: fetch the PR (metadata + diff) → expert writes a focused review →
 * github_review_pr submits it (approval-gated) so the user always reviews
 * the AI's review before it appears on the PR.
 */

import type { RoutineTemplate } from '../types/routine-templates';

interface InputMapping {
  sourceStepId: string;
  sourceField: string;
  targetField: string;
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
}

function step(cfg: {
  id: string;
  name: string;
  actionType: string;
  params: Record<string, unknown>;
  wire: string[];
  requiresApproval?: boolean;
  onError?: Step['onError'];
}): Step {
  const inputMappings: InputMapping[] = cfg.wire.map((entry) => {
    const [left, right] = entry.split('->').map((s) => s.trim());
    const [sourceStepId, ...rest] = left.split('.');
    return { sourceStepId, sourceField: rest.join('.'), targetField: right };
  });
  const deps = Array.from(new Set(inputMappings.map((m) => m.sourceStepId)));
  return {
    id: cfg.id,
    name: cfg.name,
    actionType: cfg.actionType,
    params: cfg.params,
    dependsOn: deps,
    inputMappings,
    requiresApproval: cfg.requiresApproval ?? false,
    onError: cfg.onError ?? 'fail',
  };
}

const REVIEW_PROMPT =
  'You are reviewing PR #{{pr_number}} on {{repo_full_name}}: "{{title}}".\n\n' +
  'PR description:\n{{body}}\n\n' +
  'Author: @{{author_login}}\n' +
  'Diff (truncated to {{diff_truncated}} bytes — true means more was elided):\n\n' +
  '```diff\n{{diff}}\n```\n\n' +
  'Write a CONCISE review. Lead with the verdict (APPROVE / REQUEST_CHANGES / COMMENT). ' +
  'Then under 150 words: the most important things to fix or confirm. Group by file. Skip ' +
  'nitpicks unless they materially affect correctness. If the diff is clearly unsafe ' +
  '(secrets, security regressions, breaking schema changes), default to REQUEST_CHANGES. ' +
  'If the change is small and clean, APPROVE.';

const STEPS: Step[] = [
  step({
    id: 'fetch_pr', name: 'Fetch PR + diff', actionType: 'github_fetch_pr',
    params: {
      repo: '{{repo_full_name}}',
      pr_number: '{{pr_number}}',
      include_diff: true,
      max_diff_bytes: 200000,
    },
    wire: [
      '__trigger__.repo_full_name -> repo_full_name',
      '__trigger__.pr_number -> pr_number',
    ],
  }),
  step({
    id: 'draft_review', name: 'Draft review', actionType: 'run_expert',
    params: {
      expertId: '%%expert_id%%',
      prompt: REVIEW_PROMPT,
      additionalContext: '',
      maxTurns: 6,
    },
    wire: [
      '__trigger__.repo_full_name -> repo_full_name',
      '__trigger__.pr_number -> pr_number',
      '__trigger__.author_login -> author_login',
      'fetch_pr.title -> title',
      'fetch_pr.body -> body',
      'fetch_pr.diff -> diff',
      'fetch_pr.diff_truncated -> diff_truncated',
    ],
  }),
  step({
    id: 'submit_review', name: 'Submit review', actionType: 'github_review_pr',
    params: {
      repo: '{{repo_full_name}}',
      pr_number: '{{pr_number}}',
      event: '%%default_event%%',
      body: '{{response}}',
    },
    requiresApproval: true,
    wire: [
      '__trigger__.repo_full_name -> repo_full_name',
      '__trigger__.pr_number -> pr_number',
      'draft_review.response -> response',
    ],
  }),
];

const DAG = {
  trigger: {
    triggerType: 'trigger_github_pr_review_requested',
    config: {
      repo: '%%repo%%',
      filter_type: 'none',
      filter_value: '',
    },
  },
  steps: STEPS,
};

export const githubPrReviewTemplate: RoutineTemplate = {
  id: 'github-pr-review',
  name: 'GitHub: PR Review Requested → AI Review',
  description:
    'When a reviewer is requested on a PR in %%repo%%, an expert drafts a focused review against the diff. ' +
    'You approve the review before it posts.',
  category: 'integrations',
  requiredConnections: ['github'],
  plainEnglishSteps: [
    'Someone requests you as a reviewer on a PR in %%repo%%',
    'Cerebro fetches the PR metadata and diff',
    'The chosen expert drafts a concise review',
    'You approve the draft, then it posts to GitHub as a review',
  ],
  dagJson: JSON.stringify(DAG, null, 2),
  triggerType: 'github_pr_review_requested',
  triggerConfig: {
    repo: '%%repo%%',
    filter_type: 'none',
    filter_value: '',
  },
  variables: [
    {
      key: 'repo',
      label: 'Repository (owner/name)',
      description: 'Must be in your watched-repo allowlist. Use * to match any watched repo.',
      type: 'text',
      placeholder: 'cerebro-ai/cerebro',
      required: true,
    },
    {
      key: 'expert_id',
      label: 'Expert that reviews',
      description: 'A code-reviewer expert. The diff and PR body are fed in as context.',
      type: 'text',
      placeholder: 'expert id from /experts',
      required: true,
    },
    {
      key: 'default_event',
      label: 'Default review verdict',
      description: 'Submission verdict if the expert is non-committal. The expert can override in its draft.',
      type: 'select',
      required: true,
      default: 'COMMENT',
      options: [
        { value: 'COMMENT', label: 'Comment (non-blocking)' },
        { value: 'APPROVE', label: 'Approve' },
        { value: 'REQUEST_CHANGES', label: 'Request changes' },
      ],
    },
  ],
};
