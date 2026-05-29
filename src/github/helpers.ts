/**
 * Pure helpers for the GitHub bridge — kept here so tests can exercise
 * them without booting Electron, the engine bus, or http.
 *
 * Mirrors the Telegram helpers shape: routines store their canvas trigger
 * config under `dag_json.trigger`, so we parse those out, then filter
 * against the inbound event before dispatching `engine.startRun`.
 */

import type { DAGDefinition } from '../engine/dag/types';
import type { GitHubEventType } from './types';

interface CanvasDagJson extends DAGDefinition {
  trigger?: {
    triggerType?: string;
    config?: Record<string, unknown>;
  };
}

export type GitHubFilterType = 'none' | 'keyword' | 'regex' | 'label';

/** Trigger config shape stored in CanvasDefinition.trigger.config. */
export interface GitHubTriggerConfig {
  /** Repo full_name (e.g. "octocat/hello-world") or "*" to match any watched repo. */
  repo: string;
  /** Optional title/body filter. `label` matches against the issue/PR labels[].name. */
  filter_type?: GitHubFilterType;
  filter_value?: string;
}

export interface GitHubTriggerRoutine {
  id: string;
  name: string;
  dag: DAGDefinition;
  /** The canvas trigger type, used to gate which routines run on which event. */
  triggerType: GitHubEventType;
  trigger: GitHubTriggerConfig;
}

/** Loose backend Routine row — only the fields we read for trigger matching. */
export interface BackendRoutineRecord {
  id: string;
  name: string;
  is_enabled: boolean;
  trigger_type: string;
  dag_json: string | null;
}

const TRIGGER_NODE_TYPES: Record<string, GitHubEventType> = {
  trigger_github_issue_opened: 'github_issue_opened',
  trigger_github_pr_review_requested: 'github_pr_review_requested',
};

/**
 * Pull the trigger config out of a routine's dag_json. Returns null if the
 * canvas trigger isn't a github_* one or required fields are missing.
 */
export function parseGitHubTriggerRoutine(record: BackendRoutineRecord): GitHubTriggerRoutine | null {
  if (!record.dag_json) return null;
  let dag: CanvasDagJson;
  try {
    dag = JSON.parse(record.dag_json) as CanvasDagJson;
  } catch {
    return null;
  }
  const canvasType = dag.trigger?.triggerType;
  if (typeof canvasType !== 'string') return null;
  const eventType = TRIGGER_NODE_TYPES[canvasType];
  if (!eventType) return null;

  const cfg = dag.trigger?.config ?? {};
  const repo = typeof cfg.repo === 'string' ? cfg.repo.trim() : '';
  if (!repo) return null;
  const rawFilterType = typeof cfg.filter_type === 'string' ? cfg.filter_type : 'none';
  const filter_type: GitHubFilterType = (
    rawFilterType === 'keyword' || rawFilterType === 'regex' || rawFilterType === 'label'
      ? rawFilterType : 'none'
  );
  const filter_value = typeof cfg.filter_value === 'string' ? cfg.filter_value : '';

  return {
    id: record.id,
    name: record.name,
    dag: { steps: dag.steps ?? [] },
    triggerType: eventType,
    trigger: { repo, filter_type, filter_value },
  };
}

/** True if the inbound event matches a routine's filter. */
export function matchesGitHubFilter(
  haystack: { title: string; body: string; labels: string[] },
  filterType: GitHubFilterType | undefined,
  filterValue: string | undefined,
): boolean {
  const type = filterType ?? 'none';
  const value = (filterValue ?? '').trim();
  if (type === 'none' || value === '') return true;
  const text = `${haystack.title}\n${haystack.body}`;
  if (type === 'keyword') {
    return new RegExp(`\\b${escapeRegExp(value)}\\b`, 'i').test(text);
  }
  if (type === 'regex') {
    try {
      return new RegExp(value, 'i').test(text);
    } catch {
      return false;
    }
  }
  if (type === 'label') {
    const wanted = value.toLowerCase();
    return haystack.labels.some((l) => l.toLowerCase() === wanted);
  }
  return false;
}

/** Filter a list of pre-parsed routines against a single inbound event. */
export function matchRoutineTriggers(
  routines: GitHubTriggerRoutine[],
  event: {
    type: GitHubEventType;
    repoFullName: string;
    title: string;
    body: string;
    labels: string[];
  },
): GitHubTriggerRoutine[] {
  const matched: GitHubTriggerRoutine[] = [];
  for (const r of routines) {
    if (r.triggerType !== event.type) continue;
    const target = r.trigger.repo;
    const repoMatches = target === '*' || target === event.repoFullName;
    if (!repoMatches) continue;
    if (!matchesGitHubFilter(
      { title: event.title, body: event.body, labels: event.labels },
      r.trigger.filter_type,
      r.trigger.filter_value,
    )) continue;
    matched.push(r);
  }
  return matched;
}

/** Validate "owner/repo" format. Used by Settings UI input + add-watched-repo path. */
export function isValidRepoFullName(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/.test(value.trim());
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
