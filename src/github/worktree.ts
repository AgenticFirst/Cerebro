/**
 * Git worktree helpers for the GitHub auto-fix flow.
 *
 * Shells out to the local `git` binary so the routine can clone a repo
 * into a temp directory, let an expert (run_expert / run_claude_code)
 * write code in that dir, then commit + push a branch. The PR is created
 * separately via the REST API in github_open_pr.
 *
 * Why git CLI rather than libgit2 / isomorphic-git: every dev machine
 * already has git, the CLI handles auth (HTTPS w/ token, SSH, GH CLI
 * helpers) without reimplementation, and shelling out keeps the runtime
 * surface small.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export interface CloneOpts {
  /** "owner/repo". */
  repoFullName: string;
  /** PAT used for HTTPS auth. */
  token: string;
  /** Branch to check out before edits. Defaults to remote HEAD. */
  baseBranch?: string;
  /** Optional override for the parent dir of the temp worktree. */
  parentDir?: string;
}

export interface CloneResult {
  worktreePath: string;
  /** Resolved base branch name (e.g. "main"). */
  baseBranch: string;
}

export interface CommitAndPushOpts {
  worktreePath: string;
  /** Branch name to create + push (e.g. "cerebro/fix-issue-42"). */
  branch: string;
  /** Single commit message. Multi-commit flows aren't in scope for MVP. */
  commitMessage: string;
  /** Author identity for the commit (falls back to "Cerebro <noreply@…>"). */
  authorName?: string;
  authorEmail?: string;
  /** PAT for the push (re-injected into remote URL). */
  token: string;
}

export interface CommitAndPushResult {
  /** Sha of the new commit. */
  commitSha: string;
  /** Branch ref pushed to remote (the input `branch`). */
  branch: string;
  /** True if there was nothing to commit (worktree clean). */
  noChanges: boolean;
}

interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DEFAULT_AUTHOR_NAME = 'Cerebro';
const DEFAULT_AUTHOR_EMAIL = 'noreply@cerebro.local';
const GIT_TIMEOUT_MS = 5 * 60_000;

/** Run `git` with given args in `cwd`, capturing output. */
async function runGit(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<GitRunResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, ...(env ?? {}), GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timeout: NodeJS.Timeout | null = setTimeout(() => {
      child.kill('SIGKILL');
    }, GIT_TIMEOUT_MS);
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
    child.on('close', (code) => {
      if (timeout) { clearTimeout(timeout); timeout = null; }
      resolve({
        ok: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? -1,
      });
    });
    child.on('error', (err) => {
      if (timeout) { clearTimeout(timeout); timeout = null; }
      resolve({ ok: false, stdout: '', stderr: err.message, exitCode: -1 });
    });
  });
}

/** Embed the token into the HTTPS URL so the clone/push doesn't prompt. */
function buildAuthenticatedUrl(repoFullName: string, token: string): string {
  // GitHub accepts `x-access-token:<PAT>@github.com` for both classic and
  // fine-grained PATs.
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${repoFullName}.git`;
}

export async function cloneWorktree(opts: CloneOpts): Promise<CloneResult> {
  const parent = opts.parentDir ?? path.join(os.tmpdir(), 'cerebro-github-worktrees');
  fs.mkdirSync(parent, { recursive: true });
  const safeName = opts.repoFullName.replace(/[^A-Za-z0-9_-]/g, '_');
  const dir = fs.mkdtempSync(path.join(parent, `${safeName}-`));
  const url = buildAuthenticatedUrl(opts.repoFullName, opts.token);
  // Shallow clone keeps it fast; depth=1 is enough for branch-from-default flows.
  const args = ['clone', '--depth', '1'];
  if (opts.baseBranch) args.push('--branch', opts.baseBranch);
  args.push(url, dir);
  const clone = await runGit(args, parent);
  if (!clone.ok) {
    cleanupSilently(dir);
    throw new Error(`git clone failed: ${clone.stderr || `exit ${clone.exitCode}`}`);
  }
  // Resolve actual checked-out branch (defaults when --branch wasn't passed).
  const branchRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  const baseBranch = branchRes.ok ? branchRes.stdout : (opts.baseBranch ?? 'main');
  return { worktreePath: dir, baseBranch };
}

export async function commitAndPush(opts: CommitAndPushOpts): Promise<CommitAndPushResult> {
  const cwd = opts.worktreePath;
  const author = {
    name: opts.authorName?.trim() || DEFAULT_AUTHOR_NAME,
    email: opts.authorEmail?.trim() || DEFAULT_AUTHOR_EMAIL,
  };

  const status = await runGit(['status', '--porcelain'], cwd);
  if (!status.ok) throw new Error(`git status failed: ${status.stderr}`);
  if (status.stdout.length === 0) {
    return { commitSha: '', branch: opts.branch, noChanges: true };
  }

  const checkout = await runGit(['checkout', '-b', opts.branch], cwd);
  if (!checkout.ok) {
    // Branch may already exist (rare: the same routine ran twice). Fall back to plain checkout.
    const fallback = await runGit(['checkout', opts.branch], cwd);
    if (!fallback.ok) throw new Error(`git checkout -b ${opts.branch} failed: ${checkout.stderr}`);
  }

  const add = await runGit(['add', '-A'], cwd);
  if (!add.ok) throw new Error(`git add failed: ${add.stderr}`);

  const commit = await runGit(
    ['commit', '-m', opts.commitMessage],
    cwd,
    {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
    },
  );
  if (!commit.ok) throw new Error(`git commit failed: ${commit.stderr}`);

  const sha = await runGit(['rev-parse', 'HEAD'], cwd);
  if (!sha.ok) throw new Error(`git rev-parse HEAD failed: ${sha.stderr}`);

  // Refresh the remote URL with auth before pushing — the original clone URL
  // already had it embedded, but we re-set explicitly to handle worktrees
  // that were checked out without a token.
  const remoteRes = await runGit(['config', '--get', 'remote.origin.url'], cwd);
  if (remoteRes.ok) {
    const cleaned = remoteRes.stdout.replace(/https:\/\/[^@]+@/, 'https://');
    const m = /github\.com[/:]([^/]+\/[^/.]+)/.exec(cleaned);
    if (m) {
      const reauth = buildAuthenticatedUrl(m[1], opts.token);
      await runGit(['remote', 'set-url', 'origin', reauth], cwd);
    }
  }

  const push = await runGit(['push', '-u', 'origin', opts.branch], cwd);
  if (!push.ok) throw new Error(`git push failed: ${push.stderr}`);

  return { commitSha: sha.stdout, branch: opts.branch, noChanges: false };
}

/** Delete a worktree directory. Best-effort — never throws. */
export function removeWorktree(worktreePath: string): void {
  cleanupSilently(worktreePath);
}

function cleanupSilently(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore — worktree may already be gone or held open by another process
  }
}
