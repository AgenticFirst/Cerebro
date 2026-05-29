/**
 * Shared GitHub integration types.
 *
 * Setting keys live here so both the bridge (main process) and any
 * helper that touches `/settings` can reference the same names.
 *
 * Trigger payload shape mirrors the synthetic `__trigger__` step the
 * routine executor seeds — the bridge feeds these dictionaries straight
 * into `engine.startRun({triggerPayload})`.
 */

export const GITHUB_SETTING_KEYS = {
  /** Encrypted Personal Access Token. */
  token: 'github_token',
  /** Authenticated user's login (cached so we can detect review-requested). */
  login: 'github_login',
  /** JSON array of "owner/repo" strings — repos the poller dispatches triggers for. */
  watchedRepos: 'github_watched_repos',
  /** Per-repo cursor state JSON, keyed by full_name → { issuesSince, prsLastUpdated, etag }. */
  cursors: 'github_cursors',
} as const;

export type GitHubEventType = 'github_issue_opened' | 'github_pr_review_requested';

export const GITHUB_EVENT_TYPES: readonly GitHubEventType[] = [
  'github_issue_opened',
  'github_pr_review_requested',
];

export interface GitHubTriggerPayload {
  event_type: GitHubEventType;
  repo_full_name: string;
  repo_owner: string;
  repo_name: string;
  issue_number?: number;
  pr_number?: number;
  title: string;
  body: string;
  author_login: string;
  html_url: string;
  /** ISO timestamp of when the bridge observed the event. */
  received_at: string;
}

/** Per-repo cursor state, persisted between polls. */
export interface GitHubRepoCursor {
  /** ISO timestamp passed as `since=` to the issues endpoint. */
  issuesSince?: string | null;
  /** ETag of the last successful issues poll, sent back as If-None-Match. */
  issuesEtag?: string | null;
  /** ISO timestamp of the most-recently observed PR `updated_at`. */
  prsLastUpdated?: string | null;
  prsEtag?: string | null;
  /** Set of issue/PR numbers we've already dispatched (so re-emits don't double-fire). */
  seenIssueNumbers?: number[];
  /** PRs we've already dispatched a review-requested event for, keyed by `<pr_number>`. */
  seenReviewRequests?: number[];
}

export type GitHubCursorMap = Record<string, GitHubRepoCursor>;
