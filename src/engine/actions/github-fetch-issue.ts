/**
 * github_fetch_issue — read an issue's body, labels, and comments.
 *
 * DAG-only (not chat-exposable). Used inside routines that need the full
 * issue context to feed an expert ("here is the issue body, draft a fix
 * plan").
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { GitHubChannel } from './github-channel';
import { callGitHubApi, parseRepoFullName } from '../../github/api';

interface FetchIssueParams {
  repo: string;
  issue_number: number | string;
  /** When true, also fetch up to 30 comments. Default false to keep payloads small. */
  include_comments?: boolean | string;
}

interface IssueDto {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user?: { login?: string };
  labels?: Array<{ name?: string }>;
  html_url: string;
}

interface CommentDto {
  id: number;
  body: string;
  user?: { login?: string };
  created_at: string;
  html_url: string;
}

export function createGitHubFetchIssueAction(deps: {
  getChannel: () => GitHubChannel | null;
}): ActionDefinition {
  return {
    type: 'github_fetch_issue',
    name: 'GitHub: Fetch issue',
    description: 'Read an issue (title, body, labels, optionally comments) for downstream steps.',

    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        issue_number: { type: ['integer', 'string'] },
        include_comments: { type: ['boolean', 'string'] },
      },
      required: ['repo', 'issue_number'],
    },

    outputSchema: {
      type: 'object',
      properties: {
        issue_number: { type: ['number', 'null'] },
        title: { type: 'string' },
        body: { type: 'string' },
        author_login: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
        html_url: { type: 'string' },
        comments: { type: 'array' },
        ok: { type: 'boolean' },
        error: { type: ['string', 'null'] },
      },
      required: ['ok'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel || !channel.isConnected()) {
        throw new Error('GitHub: Fetch issue — GitHub is not configured.');
      }
      const token = channel.getAccessToken()!;
      const params = input.params as unknown as FetchIssueParams;
      const vars = input.wiredInputs ?? {};

      const repo = renderTemplate(params.repo ?? '', vars).trim();
      const number = Number.parseInt(renderTemplate(String(params.issue_number ?? ''), vars).trim(), 10);
      const includeRaw = renderTemplate(String(params.include_comments ?? ''), vars).trim().toLowerCase();
      const includeComments = includeRaw === 'true' || includeRaw === '1' || includeRaw === 'yes';
      const parts = parseRepoFullName(repo);
      if (!parts) throw new Error(`GitHub: Fetch issue — invalid repo "${repo}".`);
      if (!Number.isFinite(number) || number <= 0) throw new Error('GitHub: Fetch issue — issue_number is invalid.');

      const issueRes = await callGitHubApi<IssueDto>(
        token, `/repos/${parts.owner}/${parts.repo}/issues/${number}`,
        { signal: input.context.signal },
      );
      if (!issueRes.ok || !issueRes.data) {
        return {
          data: { ok: false, error: issueRes.error, issue_number: null, title: '', body: '', author_login: '', labels: [], html_url: '', comments: [] },
          summary: `GitHub fetch_issue failed: ${issueRes.error}`,
        };
      }
      const issue = issueRes.data;
      const labels = (issue.labels ?? []).map((l) => l.name ?? '').filter(Boolean);

      let comments: Array<Record<string, unknown>> = [];
      if (includeComments) {
        const cRes = await callGitHubApi<CommentDto[]>(
          token, `/repos/${parts.owner}/${parts.repo}/issues/${number}/comments`,
          { query: { per_page: 30 }, signal: input.context.signal },
        );
        if (cRes.ok && cRes.data) {
          comments = cRes.data.map((c) => ({
            id: c.id,
            body: c.body,
            author_login: c.user?.login ?? '',
            created_at: c.created_at,
            html_url: c.html_url,
          }));
        }
      }

      return {
        data: {
          ok: true,
          error: null,
          issue_number: issue.number,
          title: issue.title,
          body: issue.body ?? '',
          author_login: issue.user?.login ?? '',
          labels,
          html_url: issue.html_url,
          comments,
        },
        summary: `Fetched ${repo}#${number}`,
      };
    },
  };
}
