/**
 * github_comment_issue — post a comment on an existing issue.
 *
 * Chat-exposable. Works with the same comments endpoint as PRs because
 * GitHub treats PRs as issues for top-level comments.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { GitHubChannel } from './github-channel';
import { callGitHubApi, parseRepoFullName } from '../../github/api';

interface CommentIssueParams {
  repo: string;
  issue_number: number | string;
  body: string;
}

export function createGitHubCommentIssueAction(deps: {
  getChannel: () => GitHubChannel | null;
}): ActionDefinition {
  return {
    type: 'github_comment_issue',
    name: 'GitHub: Comment on issue',
    description: 'Post a comment on a GitHub issue.',

    chatExposable: true,
    chatGroup: 'github',
    chatLabel: { en: 'Comment on GitHub issue', es: 'Comentar issue de GitHub' },
    chatDescription: {
      en: 'Post a comment on a GitHub issue. Requires repo, issue number, and the comment body.',
      es: 'Publica un comentario en un issue de GitHub. Requiere repo, número de issue y el cuerpo del comentario.',
    },
    chatExamples: [
      {
        en: 'Comment on cerebro-ai/cerebro#42: "Working on a fix, ETA tomorrow."',
        es: 'Comenta en cerebro-ai/cerebro#42: "Trabajando en una solución, llegará mañana."',
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
        issue_number: { type: ['integer', 'string'] },
        body: { type: 'string', description: 'Comment body in Markdown. Templated.' },
      },
      required: ['repo', 'issue_number', 'body'],
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
        throw new Error('GitHub: Comment — GitHub is not configured.');
      }
      const token = channel.getAccessToken()!;
      const params = input.params as unknown as CommentIssueParams;
      const vars = input.wiredInputs ?? {};

      const repo = renderTemplate(params.repo ?? '', vars).trim();
      const number = parseIssueNumber(params.issue_number, vars);
      const body = renderTemplate(params.body ?? '', vars).trim();
      const parts = parseRepoFullName(repo);
      if (!parts) throw new Error(`GitHub: Comment — invalid repo "${repo}".`);
      if (!Number.isFinite(number) || number <= 0) throw new Error('GitHub: Comment — issue_number is invalid.');
      if (!body) throw new Error('GitHub: Comment — body is empty.');

      const res = await callGitHubApi<{ id?: number; html_url?: string }>(
        token, `/repos/${parts.owner}/${parts.repo}/issues/${number}/comments`,
        { method: 'POST', body: { body }, signal: input.context.signal },
      );
      if (!res.ok) {
        return {
          data: { comment_id: null, comment_url: null, created: false, error: res.error },
          summary: `GitHub comment failed: ${res.error}`,
        };
      }
      const id = typeof res.data?.id === 'number' ? res.data.id : null;
      const url = typeof res.data?.html_url === 'string' ? res.data.html_url : null;
      return {
        data: { comment_id: id, comment_url: url, created: true, error: null },
        summary: `Commented on ${repo}#${number}`,
      };
    },
  };
}

function parseIssueNumber(value: unknown, vars: Record<string, unknown>): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number.parseInt(renderTemplate(value, vars).trim(), 10);
  return Number.NaN;
}
