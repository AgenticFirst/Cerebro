/**
 * github_fetch_pr — read a pull request's metadata and (optionally) the
 * full diff. DAG-only.
 *
 * The diff is fetched via the `application/vnd.github.v3.diff` accept
 * header, then trimmed to the configured byte cap so we never put a
 * many-megabyte diff on a routine scratchpad.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { GitHubChannel } from './github-channel';
import { callGitHubApi, parseRepoFullName, GITHUB_API_BASE, GITHUB_API_VERSION, GITHUB_USER_AGENT } from '../../github/api';

interface FetchPrParams {
  repo: string;
  pr_number: number | string;
  /** When true, fetch the unified diff. Default true. */
  include_diff?: boolean | string;
  /** Hard cap on bytes of diff text returned (default 200_000). */
  max_diff_bytes?: number | string;
}

interface PrDto {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user?: { login?: string };
  head: { ref: string; sha: string };
  base: { ref: string };
  html_url: string;
  draft: boolean;
  changed_files: number;
  additions: number;
  deletions: number;
}

const DEFAULT_DIFF_CAP = 200_000;

export function createGitHubFetchPrAction(deps: {
  getChannel: () => GitHubChannel | null;
}): ActionDefinition {
  return {
    type: 'github_fetch_pr',
    name: 'GitHub: Fetch pull request',
    description: 'Read PR metadata and (optionally) the diff for downstream steps.',

    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        pr_number: { type: ['integer', 'string'] },
        include_diff: { type: ['boolean', 'string'] },
        max_diff_bytes: { type: ['integer', 'string'] },
      },
      required: ['repo', 'pr_number'],
    },

    outputSchema: {
      type: 'object',
      properties: {
        pr_number: { type: ['number', 'null'] },
        title: { type: 'string' },
        body: { type: 'string' },
        author_login: { type: 'string' },
        head_ref: { type: 'string' },
        base_ref: { type: 'string' },
        head_sha: { type: 'string' },
        html_url: { type: 'string' },
        draft: { type: 'boolean' },
        changed_files: { type: 'number' },
        additions: { type: 'number' },
        deletions: { type: 'number' },
        diff: { type: 'string' },
        diff_truncated: { type: 'boolean' },
        ok: { type: 'boolean' },
        error: { type: ['string', 'null'] },
      },
      required: ['ok'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel || !channel.isConnected()) {
        throw new Error('GitHub: Fetch PR — GitHub is not configured.');
      }
      const token = channel.getAccessToken()!;
      const params = input.params as unknown as FetchPrParams;
      const vars = input.wiredInputs ?? {};

      const repo = renderTemplate(params.repo ?? '', vars).trim();
      const number = Number.parseInt(renderTemplate(String(params.pr_number ?? ''), vars).trim(), 10);
      const diffRaw = renderTemplate(String(params.include_diff ?? 'true'), vars).trim().toLowerCase();
      const includeDiff = diffRaw !== 'false' && diffRaw !== '0' && diffRaw !== 'no';
      const capRaw = renderTemplate(String(params.max_diff_bytes ?? DEFAULT_DIFF_CAP), vars).trim();
      const cap = Number.parseInt(capRaw, 10);
      const maxBytes = Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_DIFF_CAP;
      const parts = parseRepoFullName(repo);
      if (!parts) throw new Error(`GitHub: Fetch PR — invalid repo "${repo}".`);
      if (!Number.isFinite(number) || number <= 0) throw new Error('GitHub: Fetch PR — pr_number is invalid.');

      const prRes = await callGitHubApi<PrDto>(
        token, `/repos/${parts.owner}/${parts.repo}/pulls/${number}`,
        { signal: input.context.signal },
      );
      if (!prRes.ok || !prRes.data) {
        return {
          data: emptyPrPayload(prRes.error),
          summary: `GitHub fetch_pr failed: ${prRes.error}`,
        };
      }
      const pr = prRes.data;

      let diffText = '';
      let truncated = false;
      if (includeDiff) {
        const diff = await fetchDiff(token, parts.owner, parts.repo, number, input.context.signal);
        if (diff !== null) {
          if (diff.length > maxBytes) {
            diffText = diff.slice(0, maxBytes);
            truncated = true;
          } else {
            diffText = diff;
          }
        }
      }

      return {
        data: {
          ok: true,
          error: null,
          pr_number: pr.number,
          title: pr.title,
          body: pr.body ?? '',
          author_login: pr.user?.login ?? '',
          head_ref: pr.head.ref,
          base_ref: pr.base.ref,
          head_sha: pr.head.sha,
          html_url: pr.html_url,
          draft: pr.draft,
          changed_files: pr.changed_files,
          additions: pr.additions,
          deletions: pr.deletions,
          diff: diffText,
          diff_truncated: truncated,
        },
        summary: `Fetched PR ${repo}#${number}`,
      };
    },
  };
}

async function fetchDiff(
  token: string, owner: string, repo: string, number: number, signal: AbortSignal,
): Promise<string | null> {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${number}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3.diff',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': GITHUB_USER_AGENT,
      },
      signal,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function emptyPrPayload(error: string | null): Record<string, unknown> {
  return {
    ok: false, error,
    pr_number: null, title: '', body: '', author_login: '',
    head_ref: '', base_ref: '', head_sha: '', html_url: '',
    draft: false, changed_files: 0, additions: 0, deletions: 0,
    diff: '', diff_truncated: false,
  };
}
