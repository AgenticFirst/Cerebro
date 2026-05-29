/**
 * github_clone_worktree — shallow-clone a repo into a temp directory.
 *
 * DAG-only. Pairs with run_expert / run_claude_code (which can edit files
 * in the returned `worktree_path`) and github_commit_and_push (which
 * stages, commits, and pushes the resulting branch).
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { GitHubChannel } from './github-channel';
import { cloneWorktree } from '../../github/worktree';

interface CloneParams {
  repo: string;
  base_branch?: string;
}

export function createGitHubCloneWorktreeAction(deps: {
  getChannel: () => GitHubChannel | null;
}): ActionDefinition {
  return {
    type: 'github_clone_worktree',
    name: 'GitHub: Clone worktree',
    description: 'Clone a repo into a temp directory so an expert can edit files locally.',

    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        base_branch: { type: 'string', description: 'Branch to start from. Defaults to the repo default branch.' },
      },
      required: ['repo'],
    },

    outputSchema: {
      type: 'object',
      properties: {
        worktree_path: { type: 'string' },
        base_branch: { type: 'string' },
        ok: { type: 'boolean' },
        error: { type: ['string', 'null'] },
      },
      required: ['ok'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel || !channel.isConnected()) {
        throw new Error('GitHub: Clone worktree — GitHub is not configured.');
      }
      const token = channel.getAccessToken()!;
      const params = input.params as unknown as CloneParams;
      const vars = input.wiredInputs ?? {};

      const repo = renderTemplate(params.repo ?? '', vars).trim();
      const baseBranch = renderTemplate(params.base_branch ?? '', vars).trim();
      if (!repo) throw new Error('GitHub: Clone worktree — repo is empty.');

      try {
        const result = await cloneWorktree({
          repoFullName: repo,
          token,
          baseBranch: baseBranch || undefined,
        });
        input.context.log(`Cloned ${repo} into ${result.worktreePath} (base: ${result.baseBranch})`);
        return {
          data: { worktree_path: result.worktreePath, base_branch: result.baseBranch, ok: true, error: null },
          summary: `Cloned ${repo} (base: ${result.baseBranch})`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          data: { worktree_path: '', base_branch: '', ok: false, error: msg },
          summary: `Clone failed: ${msg}`,
        };
      }
    },
  };
}
