/**
 * "GitHub Issue → AI Fix PR" template.
 *
 * Trigger: a new issue opens on a watched repo.
 * Flow: fetch the full issue → expert reads it and drafts a fix plan →
 * clone the repo into a temp worktree → second expert run actually edits
 * files in that worktree → commit + push (approval gate) → open the PR
 * (approval gate). Both writes are gated so the user always reviews the
 * diff before it hits GitHub.
 *
 * Variables let the user pick the expert that does the planning + writing,
 * the base branch, and the branch-name prefix.
 */

import type { RoutineTemplate } from '../types/routine-templates';

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

const PLAN_PROMPT =
  'A new issue opened on {{repo_full_name}} (#{{issue_number}}).\n\n' +
  'Title: {{title}}\n\n' +
  'Body:\n{{body}}\n\n' +
  'Comments so far:\n{{comments_summary}}\n\n' +
  'Read the issue carefully and respond with: (1) a one-paragraph diagnosis of the underlying ' +
  'problem, (2) the SHORTEST plausible fix, scoped to the smallest set of files. If the issue is ' +
  'too vague to fix without more info from the reporter, say so explicitly and STOP — do not invent a fix.';

const WRITE_PROMPT =
  'You are working in a fresh checkout of {{repo_full_name}} at: {{worktree_path}}\n\n' +
  'Issue context:\n{{plan}}\n\n' +
  'Apply the fix now. Use Read/Edit/Write directly in the worktree. Keep the change minimal — only ' +
  'touch files that are part of the fix. Do not run tests or builds. When done, reply with a SHORT ' +
  'summary (under 80 words) of what you changed; that becomes the PR description.';

const STEPS: Step[] = [
  step({
    id: 'fetch_issue', name: 'Fetch issue + comments', actionType: 'github_fetch_issue',
    params: { repo: '{{repo_full_name}}', issue_number: '{{issue_number}}', include_comments: true },
    wire: [
      '__trigger__.repo_full_name -> repo_full_name',
      '__trigger__.issue_number -> issue_number',
    ],
  }),
  step({
    id: 'plan_fix', name: 'Plan the fix', actionType: 'run_expert',
    params: {
      expertId: '%%expert_id%%',
      prompt: PLAN_PROMPT,
      additionalContext: 'Be concrete. List exact file paths.',
      maxTurns: 8,
    },
    wire: [
      '__trigger__.repo_full_name -> repo_full_name',
      '__trigger__.issue_number -> issue_number',
      'fetch_issue.title -> title',
      'fetch_issue.body -> body',
      'fetch_issue.comments -> comments_summary',
    ],
  }),
  step({
    id: 'clone', name: 'Clone repo into worktree', actionType: 'github_clone_worktree',
    params: { repo: '{{repo_full_name}}', base_branch: '%%base_branch%%' },
    wire: ['__trigger__.repo_full_name -> repo_full_name'],
  }),
  step({
    id: 'apply_fix', name: 'Apply fix in worktree', actionType: 'run_expert',
    params: {
      expertId: '%%expert_id%%',
      prompt: WRITE_PROMPT,
      additionalContext: '',
      workspacePath: '{{worktree_path}}',
      maxTurns: 30,
    },
    wire: [
      '__trigger__.repo_full_name -> repo_full_name',
      'clone.worktree_path -> worktree_path',
      'plan_fix.response -> plan',
    ],
  }),
  step({
    id: 'commit_push', name: 'Commit + push branch', actionType: 'github_commit_and_push',
    params: {
      worktree_path: '{{worktree_path}}',
      branch: '%%branch_prefix%%-{{issue_number}}',
      commit_message: 'fix: address issue #{{issue_number}}\n\n{{summary}}',
      cleanup: true,
    },
    requiresApproval: true,
    wire: [
      '__trigger__.issue_number -> issue_number',
      'clone.worktree_path -> worktree_path',
      'apply_fix.response -> summary',
    ],
  }),
  step({
    id: 'open_pr', name: 'Open pull request', actionType: 'github_open_pr',
    params: {
      repo: '{{repo_full_name}}',
      base: '%%base_branch%%',
      head: '{{branch}}',
      title: 'fix: {{title}} (closes #{{issue_number}})',
      body:
        'Auto-fix proposed by Cerebro for #{{issue_number}}.\n\n' +
        '## Summary\n{{summary}}\n\n' +
        '## Plan\n{{plan}}\n\n' +
        'Closes #{{issue_number}}.',
    },
    requiresApproval: true,
    wire: [
      '__trigger__.repo_full_name -> repo_full_name',
      '__trigger__.issue_number -> issue_number',
      '__trigger__.title -> title',
      'commit_push.branch -> branch',
      'apply_fix.response -> summary',
      'plan_fix.response -> plan',
    ],
  }),
];

const DAG = {
  trigger: {
    triggerType: 'trigger_github_issue_opened',
    config: {
      repo: '%%repo%%',
      filter_type: 'none',
      filter_value: '',
    },
  },
  steps: STEPS,
};

export const githubIssueToFixPrTemplate: RoutineTemplate = {
  id: 'github-issue-to-fix-pr',
  name: 'GitHub: Issue → AI Fix PR',
  description:
    'When a new issue opens on %%repo%%, an expert drafts a fix in a fresh worktree, ' +
    'commits the branch, and opens a pull request — both the push and the PR are gated for your approval.',
  category: 'integrations',
  requiredConnections: ['github'],
  plainEnglishSteps: [
    'A new issue opens on %%repo%%',
    'Cerebro reads the issue body and any comments',
    'The chosen expert drafts a fix plan',
    'Cerebro clones the repo into a temporary worktree',
    'The expert writes the fix in that worktree',
    'You approve the commit + push (the diff is on disk for inspection)',
    'You approve the pull request, then it appears on GitHub',
  ],
  dagJson: JSON.stringify(DAG, null, 2),
  triggerType: 'github_issue_opened',
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
      label: 'Expert that writes the fix',
      description: 'A code-savvy expert that can read an issue and produce a minimal patch.',
      type: 'text',
      placeholder: 'expert id from /experts',
      required: true,
    },
    {
      key: 'base_branch',
      label: 'Base branch',
      description: 'Branch the PR targets and the worktree starts from.',
      type: 'text',
      required: true,
      default: 'main',
    },
    {
      key: 'branch_prefix',
      label: 'Branch name prefix',
      description: 'New branch will be `<prefix>-<issue_number>`.',
      type: 'text',
      required: true,
      default: 'cerebro/fix-issue',
    },
  ],
};
