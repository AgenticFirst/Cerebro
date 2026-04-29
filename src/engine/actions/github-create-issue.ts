/**
 * github_create_issue — open a new issue on a repository.
 *
 * Chat-exposable: the user can say "open an issue on octocat/hello-world
 * titled 'login broken'" and the chat skill maps it to this action. Always
 * gated through the chat-action approval flow before hitting GitHub.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { GitHubChannel } from './github-channel';
import { callGitHubApi, parseRepoFullName } from '../../github/api';

interface CreateIssueParams {
  repo: string;
  title: string;
  body?: string;
  labels?: string[] | string;
  assignees?: string[] | string;
}

export function createGitHubCreateIssueAction(deps: {
  getChannel: () => GitHubChannel | null;
}): ActionDefinition {
  return {
    type: 'github_create_issue',
    name: 'GitHub: Create issue',
    description: 'Open a new issue on a GitHub repository.',

    chatExposable: true,
    chatGroup: 'github',
    chatLabel: { en: 'Create GitHub issue', es: 'Crear issue de GitHub' },
    chatDescription: {
      en: 'Open a new issue on the named repo. Requires repo (owner/name) and a title; body, labels, and assignees are optional.',
      es: 'Abre un nuevo issue en el repositorio indicado. Requiere repo (owner/nombre) y título; el cuerpo, las etiquetas y los asignados son opcionales.',
    },
    chatExamples: [
      {
        en: "Open a GitHub issue on cerebro-ai/cerebro titled 'login button is broken'.",
        es: "Abre un issue de GitHub en cerebro-ai/cerebro con el título 'el botón de login no funciona'.",
      },
      {
        en: 'Create an issue on octocat/hello-world: the README is missing install steps.',
        es: 'Crea un issue en octocat/hello-world: el README no tiene los pasos de instalación.',
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
        repo: { type: 'string', description: '"owner/repo" target.' },
        title: { type: 'string', description: 'Issue title. Templated.' },
        body: { type: 'string', description: 'Issue body in Markdown. Templated.' },
        labels: {
          oneOf: [
            { type: 'array', items: { type: 'string' } },
            { type: 'string', description: 'Comma-separated label names.' },
          ],
        },
        assignees: {
          oneOf: [
            { type: 'array', items: { type: 'string' } },
            { type: 'string', description: 'Comma-separated GitHub logins.' },
          ],
        },
      },
      required: ['repo', 'title'],
    },

    outputSchema: {
      type: 'object',
      properties: {
        issue_number: { type: ['number', 'null'] },
        issue_url: { type: ['string', 'null'] },
        created: { type: 'boolean' },
        error: { type: ['string', 'null'] },
      },
      required: ['created'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel || !channel.isConnected()) {
        throw new Error('GitHub: Create issue — GitHub is not configured. Connect GitHub in Integrations first.');
      }
      const token = channel.getAccessToken()!;
      const params = input.params as unknown as CreateIssueParams;
      const vars = input.wiredInputs ?? {};

      const repo = renderTemplate(params.repo ?? '', vars).trim();
      const title = renderTemplate(params.title ?? '', vars).trim();
      const body = renderTemplate(params.body ?? '', vars).trim();
      const parts = parseRepoFullName(repo);
      if (!parts) throw new Error(`GitHub: Create issue — invalid repo "${repo}". Expected "owner/name".`);
      if (!title) throw new Error('GitHub: Create issue — title is empty.');

      const labels = normalizeList(params.labels, vars);
      const assignees = normalizeList(params.assignees, vars);

      const reqBody: Record<string, unknown> = { title };
      if (body) reqBody.body = body;
      if (labels.length > 0) reqBody.labels = labels;
      if (assignees.length > 0) reqBody.assignees = assignees;

      const res = await callGitHubApi<{ number?: number; html_url?: string }>(
        token, `/repos/${parts.owner}/${parts.repo}/issues`,
        { method: 'POST', body: reqBody, signal: input.context.signal },
      );
      if (!res.ok) {
        input.context.log(`GitHub create_issue ${res.status}: ${res.error}`);
        return {
          data: { issue_number: null, issue_url: null, created: false, error: res.error },
          summary: `GitHub create_issue failed: ${res.error}`,
        };
      }
      const num = typeof res.data?.number === 'number' ? res.data.number : null;
      const url = typeof res.data?.html_url === 'string' ? res.data.html_url : null;
      input.context.log(`GitHub issue #${num} created on ${repo}`);
      return {
        data: { issue_number: num, issue_url: url, created: true, error: null },
        summary: `Opened issue #${num ?? '?'} on ${repo}`,
      };
    },
  };
}

function normalizeList(value: unknown, vars: Record<string, unknown>): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => renderTemplate(String(v ?? ''), vars).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return renderTemplate(value, vars)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}
