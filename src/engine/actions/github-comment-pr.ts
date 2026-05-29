/**
 * github_comment_pr — top-level comment on a pull request.
 *
 * For inline review comments (line-level) use github_review_pr with
 * action='COMMENT'. For a "general" PR comment GitHub's API treats PRs
 * as issues, so this hits the same /issues/{n}/comments endpoint.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { GitHubChannel } from './github-channel';
import { callGitHubApi, parseRepoFullName } from '../../github/api';

interface CommentPrParams {
  repo: string;
  pr_number: number | string;
  body: string;
}

export function createGitHubCommentPrAction(deps: {
  getChannel: () => GitHubChannel | null;
}): ActionDefinition {
  return {
    type: 'github_comment_pr',
    name: 'GitHub: Comment on pull request',
    description: 'Post a top-level comment on a pull request.',

    chatExposable: true,
    chatGroup: 'github',
    chatLabel: { en: 'Comment on GitHub PR', es: 'Comentar PR de GitHub' },
    chatDescription: {
      en: 'Post a top-level comment on a pull request. For line-level review feedback, use the review action instead.',
      es: 'Publica un comentario general en un pull request. Para comentarios línea por línea, usa la acción de revisión.',
    },
    chatExamples: [
      {
        en: 'Comment on PR #128 in cerebro-ai/cerebro: "Looks good, will land after tests."',
        es: 'Comenta en el PR #128 de cerebro-ai/cerebro: "Se ve bien, lo mergeo cuando pasen los tests."',
      },
    ],
    availabilityCheck: () => {
      const ch = deps.getChannel();
      if (!ch) return 'not_connected';
      return ch.isConnected() ? 'available' : 'not_connected';
    },
    setupHref: 'integrations#github',

    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        pr_number: { type: ['integer', 'string'] },
        body: { type: 'string', description: 'Comment body in Markdown. Templated.' },
      },
      required: ['repo', 'pr_number', 'body'],
    },

    outputSchema: {
      type: 'object',
      properties: {
        comment_id: { type: ['number', 'null'] },
        comment_url: { type: ['string', 'null'] },
        created: { type: 'boolean' },
        error: { type: ['string', 'null'] },
      },
      required: ['created'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel || !channel.isConnected()) {
        throw new Error('GitHub: Comment PR — GitHub is not configured.');
      }
      const token = channel.getAccessToken()!;
      const params = input.params as unknown as CommentPrParams;
      const vars = input.wiredInputs ?? {};

      const repo = renderTemplate(params.repo ?? '', vars).trim();
      const numStr = renderTemplate(String(params.pr_number ?? ''), vars).trim();
      const number = Number.parseInt(numStr, 10);
      const body = renderTemplate(params.body ?? '', vars).trim();
      const parts = parseRepoFullName(repo);
      if (!parts) throw new Error(`GitHub: Comment PR — invalid repo "${repo}".`);
      if (!Number.isFinite(number) || number <= 0) throw new Error('GitHub: Comment PR — pr_number is invalid.');
      if (!body) throw new Error('GitHub: Comment PR — body is empty.');

      const res = await callGitHubApi<{ id?: number; html_url?: string }>(
        token, `/repos/${parts.owner}/${parts.repo}/issues/${number}/comments`,
        { method: 'POST', body: { body }, signal: input.context.signal },
      );
      if (!res.ok) {
        return {
          data: { comment_id: null, comment_url: null, created: false, error: res.error },
          summary: `GitHub PR comment failed: ${res.error}`,
        };
      }
      const id = typeof res.data?.id === 'number' ? res.data.id : null;
      const url = typeof res.data?.html_url === 'string' ? res.data.html_url : null;
      return {
        data: { comment_id: id, comment_url: url, created: true, error: null },
        summary: `Commented on PR ${repo}#${number}`,
      };
    },
  };
}
