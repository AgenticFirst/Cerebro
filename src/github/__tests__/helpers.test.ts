/**
 * Pure-helper tests for the GitHub bridge — no network, no Electron.
 */

import { describe, expect, it } from 'vitest';
import {
  parseGitHubTriggerRoutine,
  matchesGitHubFilter,
  matchRoutineTriggers,
  isValidRepoFullName,
  type BackendRoutineRecord,
} from '../helpers';
import { parseRepoFullName } from '../api';

function recordWithCanvas(
  triggerType: string,
  config: Record<string, unknown>,
  overrides: Partial<BackendRoutineRecord> = {},
): BackendRoutineRecord {
  return {
    id: overrides.id ?? 'r1',
    name: overrides.name ?? 'test routine',
    is_enabled: overrides.is_enabled ?? true,
    trigger_type: overrides.trigger_type ?? 'github_issue_opened',
    dag_json: JSON.stringify({
      trigger: { triggerType, config },
      steps: [],
    }),
  };
}

describe('parseRepoFullName', () => {
  it('parses owner/repo', () => {
    expect(parseRepoFullName('octocat/hello-world')).toEqual({ owner: 'octocat', repo: 'hello-world' });
  });
  it('rejects extra slashes', () => {
    expect(parseRepoFullName('octocat/hello/world')).toBeNull();
  });
  it('rejects missing slash', () => {
    expect(parseRepoFullName('octocat')).toBeNull();
  });
});

describe('isValidRepoFullName', () => {
  it.each([
    ['octocat/hello-world', true],
    ['cerebro-ai/cerebro', true],
    ['Org_Name/repo.name', true],
    ['nodash', false],
    ['/leading-slash', false],
    ['trailing/', false],
    ['has spaces/repo', false],
  ])('isValidRepoFullName(%s) === %s', (input, expected) => {
    expect(isValidRepoFullName(input)).toBe(expected);
  });
});

describe('parseGitHubTriggerRoutine', () => {
  it('extracts a github_issue_opened routine', () => {
    const r = parseGitHubTriggerRoutine(
      recordWithCanvas('trigger_github_issue_opened', { repo: 'octocat/hello-world' }),
    );
    expect(r).not.toBeNull();
    expect(r!.triggerType).toBe('github_issue_opened');
    expect(r!.trigger.repo).toBe('octocat/hello-world');
    expect(r!.trigger.filter_type).toBe('none');
  });

  it('extracts a github_pr_review_requested routine with a label filter', () => {
    const r = parseGitHubTriggerRoutine(
      recordWithCanvas('trigger_github_pr_review_requested', {
        repo: '*',
        filter_type: 'label',
        filter_value: 'needs-ai-review',
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.triggerType).toBe('github_pr_review_requested');
    expect(r!.trigger.repo).toBe('*');
    expect(r!.trigger.filter_type).toBe('label');
    expect(r!.trigger.filter_value).toBe('needs-ai-review');
  });

  it('returns null for non-github triggers', () => {
    expect(parseGitHubTriggerRoutine(
      recordWithCanvas('trigger_telegram_message', { chat_id: '123' }),
    )).toBeNull();
  });

  it('returns null when repo is missing', () => {
    expect(parseGitHubTriggerRoutine(
      recordWithCanvas('trigger_github_issue_opened', {}),
    )).toBeNull();
  });

  it('returns null on invalid dag_json', () => {
    expect(parseGitHubTriggerRoutine({
      id: 'r', name: 'r', is_enabled: true, trigger_type: 'github_issue_opened',
      dag_json: '{not json',
    })).toBeNull();
  });
});

describe('matchesGitHubFilter', () => {
  const sample = { title: 'Crash on login', body: 'Repro: click X', labels: ['bug', 'p1'] };

  it('returns true for none', () => {
    expect(matchesGitHubFilter(sample, 'none', '')).toBe(true);
  });
  it('matches keyword case-insensitively', () => {
    expect(matchesGitHubFilter(sample, 'keyword', 'crash')).toBe(true);
    expect(matchesGitHubFilter(sample, 'keyword', 'logout')).toBe(false);
  });
  it('matches regex', () => {
    expect(matchesGitHubFilter(sample, 'regex', '^crash')).toBe(true);
    expect(matchesGitHubFilter(sample, 'regex', '^[!@')).toBe(false);
  });
  it('matches label exactly (case-insensitive)', () => {
    expect(matchesGitHubFilter(sample, 'label', 'BUG')).toBe(true);
    expect(matchesGitHubFilter(sample, 'label', 'frontend')).toBe(false);
  });
  it('treats empty filter_value as match-all', () => {
    expect(matchesGitHubFilter(sample, 'keyword', '')).toBe(true);
  });
});

describe('matchRoutineTriggers', () => {
  it('returns only routines whose triggerType + repo + filter all match', () => {
    const r1 = parseGitHubTriggerRoutine(
      recordWithCanvas('trigger_github_issue_opened', { repo: 'octocat/hello-world' }, { id: 'r1' }),
    )!;
    const r2 = parseGitHubTriggerRoutine(
      recordWithCanvas('trigger_github_issue_opened', { repo: '*', filter_type: 'keyword', filter_value: 'crash' }, { id: 'r2' }),
    )!;
    const r3 = parseGitHubTriggerRoutine(
      recordWithCanvas('trigger_github_pr_review_requested', { repo: '*' }, { id: 'r3' }),
    )!;
    const matches = matchRoutineTriggers([r1, r2, r3], {
      type: 'github_issue_opened',
      repoFullName: 'octocat/hello-world',
      title: 'Crash on login',
      body: '',
      labels: [],
    });
    const ids = matches.map((m) => m.id).sort();
    expect(ids).toEqual(['r1', 'r2']);
  });

  it('does not cross-fire across event types', () => {
    const r = parseGitHubTriggerRoutine(
      recordWithCanvas('trigger_github_pr_review_requested', { repo: '*' }),
    )!;
    const matches = matchRoutineTriggers([r], {
      type: 'github_issue_opened',
      repoFullName: 'octocat/hello-world',
      title: 't', body: '', labels: [],
    });
    expect(matches).toEqual([]);
  });
});
