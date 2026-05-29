/**
 * github_review_pr — submit a pull-request review.
 *
 * The GitHub review event types:
 *   COMMENT          — non-blocking feedback
 *   APPROVE          — green-light merge
 *   REQUEST_CHANGES  — block merge until further commits
 *
 * MVP supports a single top-level review body. Inline (per-line) review
 * comments can be added in a future revision.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { GitHubChannel } from './github-channel';
import { callGitHubApi, parseRepoFullName } from '../../github/api';

type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

const VALID_EVENTS: ReadonlyArray<ReviewEvent> = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];

interface ReviewParams {
  repo: string;
  pr_number: number | string;
  event?: ReviewEvent | string;
  body?: string;
}

export function createGitHubReviewPrAction(deps: {
  getChannel: () => GitHubChannel | null;
}): ActionDefinition {
  return {
    type: 'github_review_pr',
    name: 'GitHub: Review pull request',
    description: 'Submit a review on a pull request (comment, approve, or request changes).',

    chatExposable: true,
    chatGroup: 'github',
    chatLabel: { en: 'Review GitHub PR', es: 'Revisar PR de GitHub' },
    chatDescription: {
      en: 'Submit a top-level PR review. Use COMMENT for non-blocking notes, APPROVE to green-light, REQUEST_CHANGES to block merge.',
      es: 'Envía una revisión general del PR. Usa COMMENT para notas no bloqueantes, APPROVE para aprobar, REQUEST_CHANGES para bloquear el merge.',
    },
    chatExamples: [
      {
        en: 'Review PR #128 in cerebro-ai/cerebro and request changes — the migration order is wrong.',
        es: 'Revisa el PR #128 de cerebro-ai/cerebro y pide cambios — el orden de la migración está mal.',
      },
      {
        en: 'Approve PR #200 on octocat/hello-world.',
        es: 'Aprueba el PR #200 en octocat/hello-world.',
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
        event: { type: 'string', enum: ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'] },
        body: { type: 'string', description: 'Review body in Markdown. Templated. Required for COMMENT and REQUEST_CHANGES.' },
      },
      required: ['repo', 'pr_number'],
    },

    outputSchema: {
      type: 'object',
      properties: {
        review_id: { type: ['number', 'null'] },
        review_url: { type: ['string', 'null'] },
        submitted: { type: 'boolean' },
        error: { type: ['string', 'null'] },
      },
      required: ['submitted'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel || !channel.isConnected()) {
        throw new Error('GitHub: Review PR — GitHub is not configured.');
      }
      const token = channel.getAccessToken()!;
      const params = input.params as unknown as ReviewParams;
      const vars = input.wiredInputs ?? {};

      const repo = renderTemplate(params.repo ?? '', vars).trim();
      const numStr = renderTemplate(String(params.pr_number ?? ''), vars).trim();
      const number = Number.parseInt(numStr, 10);
      const eventRaw = renderTemplate(String(params.event ?? 'COMMENT'), vars).trim().toUpperCase();
      const event: ReviewEvent = (VALID_EVENTS as readonly string[]).includes(eventRaw)
        ? (eventRaw as ReviewEvent) : 'COMMENT';
      const body = renderTemplate(params.body ?? '', vars).trim();
      const parts = parseRepoFullName(repo);
      if (!parts) throw new Error(`GitHub: Review PR — invalid repo "${repo}".`);
      if (!Number.isFinite(number) || number <= 0) throw new Error('GitHub: Review PR — pr_number is invalid.');
      if ((event === 'COMMENT' || event === 'REQUEST_CHANGES') && !body) {
        throw new Error(`GitHub: Review PR — body is required for ${event}.`);
      }

      const reqBody: Record<string, unknown> = { event };
      if (body) reqBody.body = body;

      const res = await callGitHubApi<{ id?: number; html_url?: string }>(
        token, `/repos/${parts.owner}/${parts.repo}/pulls/${number}/reviews`,
        { method: 'POST', body: reqBody, signal: input.context.signal },
      );
      if (!res.ok) {
        return {
          data: { review_id: null, review_url: null, submitted: false, error: res.error },
          summary: `GitHub review failed: ${res.error}`,
        };
      }
      const id = typeof res.data?.id === 'number' ? res.data.id : null;
      const url = typeof res.data?.html_url === 'string' ? res.data.html_url : null;
      return {
        data: { review_id: id, review_url: url, submitted: true, error: null },
        summary: `Submitted ${event} review on ${repo}#${number}`,
      };
    },
  };
}
