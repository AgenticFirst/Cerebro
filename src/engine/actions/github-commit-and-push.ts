/**
 * github_commit_and_push — stage all changes in a worktree, commit, push.
 *
 * DAG-only. The push uses the same PAT that did the clone, embedded into
 * an HTTPS remote. The pushed branch can be turned into a PR via
 * github_open_pr.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { GitHubChannel } from './github-channel';
import { commitAndPush, removeWorktree } from '../../github/worktree';

interface CommitPushParams {
  worktree_path: string;
  branch: string;
  commit_message: string;
  author_name?: string;
  author_email?: string;
  /** When true, delete the worktree after a successful push. Default true. */
  cleanup?: boolean | string;
}

export function createGitHubCommitAndPushAction(deps: {
  getChannel: () => GitHubChannel | null;
}): ActionDefinition {
  return {
    type: 'github_commit_and_push',
    name: 'GitHub: Commit and push',
    description: 'Commit all changes in a worktree on a new branch and push to origin.',

    inputSchema: {
      type: 'object',
      properties: {
        worktree_path: { type: 'string', description: 'Output of github_clone_worktree.' },
        branch: { type: 'string', description: 'Branch name to create + push.' },
        commit_message: { type: 'string', description: 'Single-line or multi-line commit message. Templated.' },
        author_name: { type: 'string' },
        author_email: { type: 'string' },
        cleanup: { type: ['boolean', 'string'] },
      },
      required: ['worktree_path', 'branch', 'commit_message'],
    },

    outputSchema: {
      type: 'object',
      properties: {
        commit_sha: { type: 'string' },
        branch: { type: 'string' },
        no_changes: { type: 'boolean' },
        ok: { type: 'boolean' },
        error: { type: ['string', 'null'] },
      },
      required: ['ok'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel || !channel.isConnected()) {
        throw new Error('GitHub: Commit & push — GitHub is not configured.');
      }
      const token = channel.getAccessToken()!;
      const params = input.params as unknown as CommitPushParams;
      const vars = input.wiredInputs ?? {};

      const worktree = renderTemplate(params.worktree_path ?? '', vars).trim();
      const branch = renderTemplate(params.branch ?? '', vars).trim();
      const message = renderTemplate(params.commit_message ?? '', vars).trim();
      const authorName = renderTemplate(params.author_name ?? '', vars).trim();
      const authorEmail = renderTemplate(params.author_email ?? '', vars).trim();
      const cleanupRaw = renderTemplate(String(params.cleanup ?? 'true'), vars).trim().toLowerCase();
      const cleanup = cleanupRaw !== 'false' && cleanupRaw !== '0' && cleanupRaw !== 'no';

      if (!worktree) throw new Error('GitHub: Commit & push — worktree_path is empty.');
      if (!branch) throw new Error('GitHub: Commit & push — branch is empty.');
      if (!message) throw new Error('GitHub: Commit & push — commit_message is empty.');

      try {
        const result = await commitAndPush({
          worktreePath: worktree,
          branch,
          commitMessage: message,
          authorName: authorName || undefined,
          authorEmail: authorEmail || undefined,
          token,
        });
        if (cleanup && !result.noChanges) removeWorktree(worktree);
        input.context.log(
          result.noChanges
            ? `worktree ${worktree} had no changes`
            : `pushed ${result.branch} (${result.commitSha.slice(0, 7)})`,
        );
        return {
          data: {
            commit_sha: result.commitSha,
            branch: result.branch,
            no_changes: result.noChanges,
            ok: true,
            error: null,
          },
          summary: result.noChanges
            ? 'Worktree had no changes (nothing pushed)'
            : `Pushed ${result.branch} (${result.commitSha.slice(0, 7)})`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          data: { commit_sha: '', branch, no_changes: false, ok: false, error: msg },
          summary: `Commit & push failed: ${msg}`,
        };
      }
    },
  };
}
