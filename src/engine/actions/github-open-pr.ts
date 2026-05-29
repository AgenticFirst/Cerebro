/**
 * github_open_pr — create a pull request from an existing branch.
 *
 * Pairs with github_clone_worktree + github_commit_and_push: those produce
 * a branch on the remote, and this action turns it into a PR. Also
 * standalone-callable from chat ("open a PR from feat/x to main on
 * owner/repo titled '…'").
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { GitHubChannel } from './github-channel';
import { callGitHubApi, parseRepoFullName } from '../../github/api';

interface OpenPrParams {
  repo: string;
  /** Base branch (the destination — e.g. "main"). */
  base: string;
  /** Head branch (the source — e.g. "cerebro/fix-issue-42"). */
  head: string;
  title: string;
  body?: string;
  draft?: boolean | string;
}

export function createGitHubOpenPrAction(deps: {
  getChannel: () => GitHubChannel | null;
}): ActionDefinition {
  return {
    type: 'github_open_pr',
    name: 'GitHub: Open pull request',
    description: 'Create a pull request from a branch.',

    chatExposable: true,
    chatGroup: 'github',
    chatLabel: { en: 'Open GitHub pull request', es: 'Abrir pull request de GitHub' },
    chatDescription: {
      en: 'Open a pull request from one branch to another. Requires repo, base branch, head branch, and title.',
      es: 'Abre un pull request desde una rama a otra. Requiere repo, rama base, rama head y título.',
    },
    chatExamples: [
      {
        en: 'Open a PR on cerebro-ai/cerebro from feat/login-fix into main titled "Fix login button".',
        es: 'Abre un PR en cerebro-ai/cerebro desde feat/login-fix hacia main titulado "Arregla el botón de login".',
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
        base: { type: 'string' },
        head: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string', description: 'PR body in Markdown. Templated.' },
        draft: { type: ['boolean', 'string'], description: 'Open as draft.' },
      },
      required: ['repo', 'base', 'head', 'title'],
    },

    outputSchema: {
      type: 'object',
      properties: {
        pr_number: { type: ['number', 'null'] },
        pr_url: { type: ['string', 'null'] },
        created: { type: 'boolean' },
        error: { type: ['string', 'null'] },
      },
      required: ['created'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel || !channel.isConnected()) {
        throw new Error('GitHub: Open PR — GitHub is not configured.');
      }
      const token = channel.getAccessToken()!;
      const params = input.params as unknown as OpenPrParams;
      const vars = input.wiredInputs ?? {};

      const repo = renderTemplate(params.repo ?? '', vars).trim();
      const base = renderTemplate(params.base ?? '', vars).trim();
      const head = renderTemplate(params.head ?? '', vars).trim();
      const title = renderTemplate(params.title ?? '', vars).trim();
      const body = renderTemplate(params.body ?? '', vars).trim();
      const draftRaw = renderTemplate(String(params.draft ?? ''), vars).trim().toLowerCase();
      const draft = draftRaw === 'true' || draftRaw === '1' || draftRaw === 'yes';
      const parts = parseRepoFullName(repo);
      if (!parts) throw new Error(`GitHub: Open PR — invalid repo "${repo}".`);
      if (!base) throw new Error('GitHub: Open PR — base is empty.');
      if (!head) throw new Error('GitHub: Open PR — head is empty.');
      if (!title) throw new Error('GitHub: Open PR — title is empty.');

      const reqBody: Record<string, unknown> = { title, head, base };
      if (body) reqBody.body = body;
      if (draft) reqBody.draft = true;

      const res = await callGitHubApi<{ number?: number; html_url?: string }>(
        token, `/repos/${parts.owner}/${parts.repo}/pulls`,
        { method: 'POST', body: reqBody, signal: input.context.signal },
      );
      if (!res.ok) {
        return {
          data: { pr_number: null, pr_url: null, created: false, error: res.error },
          summary: `GitHub open_pr failed: ${res.error}`,
        };
      }
      const num = typeof res.data?.number === 'number' ? res.data.number : null;
      const url = typeof res.data?.html_url === 'string' ? res.data.html_url : null;
      return {
        data: { pr_number: num, pr_url: url, created: true, error: null },
        summary: `Opened PR #${num ?? '?'} on ${repo}`,
      };
    },
  };
}
