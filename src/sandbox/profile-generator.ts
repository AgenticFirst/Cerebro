/**
 * Generates a macOS Seatbelt (sandbox-exec) profile for the Claude Code
 * subprocess.
 *
 * Security model:
 *   - Reads: allow everything, deny specific sensitive paths (credentials,
 *     mail, etc.). Claude Code + Node.js need to read from many system and
 *     user-library paths that are impractical to enumerate; the deny rules
 *     provide the real protection.
 *   - Writes: narrow — workspace, ~/.claude, ~/.local, ~/Library/Caches,
 *     tmp dirs, and RW-linked projects. This is the main sandbox value:
 *     preventing the subprocess from modifying files outside its workspace.
 *   - Deny rules override allows (Seatbelt last-match-wins), so sensitive
 *     paths are protected even with broad read access.
 *
 * Forbidden zones are passed in from the caller (sourced from the backend
 * validation list) rather than hardcoded here — a single source of truth.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SandboxConfig } from './types';

/**
 * Standard package-manager and language-toolchain dirs the agent needs to
 * write into so that `pip install --user`, `npm i -g`, `brew install`,
 * `cargo install`, etc. behave the same as in the user's own terminal.
 *
 * We add the path to the sandbox profile only when it actually exists on
 * disk — keeps the generated profile compact and avoids confusing
 * `sandbox-exec` with paths that the user has never used.
 *
 * Each entry is relative to $HOME unless it begins with `/`. Order is
 * irrelevant; the profile sorts alphabetically.
 */
const TOOLCHAIN_WRITE_PATHS = [
  // Python
  'Library/Python',
  '.pyenv',
  // JS / TS
  '.npm',
  '.npm-global',
  '.yarn',
  '.config/yarn',
  '.nvm',
  '.bun',
  '.deno',
  // Rust
  '.cargo',
  '.rustup',
  // Go
  'go',
  // XDG-style caches and configs many CLIs write into
  '.cache',
  '.config',
  '.local/share',
  // Homebrew (Apple Silicon default location)
  '/opt/homebrew/var',
  '/opt/homebrew/Cellar',
  '/opt/homebrew/etc',
  '/opt/homebrew/lib',
  // Homebrew (Intel default location)
  '/usr/local/var/homebrew',
  '/usr/local/Cellar',
];

function quoteSubpath(kind: 'subpath' | 'literal', value: string): string {
  // Seatbelt string literals don't support backslash escaping. Refuse anything
  // with a double quote — the validator should have caught it already.
  if (value.includes('"')) {
    throw new Error(`Sandbox profile: refusing path containing a double quote: ${value}`);
  }
  return `(${kind} "${value}")`;
}

export interface ProfileInputs {
  workspacePath: string;
  cerebroDataDir: string;
  linkedProjects: SandboxConfig['linked_projects'];
  forbiddenHomeSubpaths: readonly string[];
}

export function generateProfile(inputs: ProfileInputs): string {
  const home = os.homedir();
  const workspace = path.resolve(inputs.workspacePath);
  const cerebroData = path.resolve(inputs.cerebroDataDir);

  const writeTargets = new Set<string>();

  // Baseline writable targets.
  writeTargets.add(workspace);
  writeTargets.add(cerebroData);
  writeTargets.add(path.join(home, '.claude'));
  // Claude Code stores auth/session state under ~/.local/{state,share}/claude
  // and caches under ~/Library/Caches/claude-cli-nodejs.
  writeTargets.add(path.join(home, '.local'));
  writeTargets.add(path.join(home, 'Library', 'Caches'));
  writeTargets.add('/private/var/folders');
  writeTargets.add('/private/tmp');
  writeTargets.add('/private/var/tmp');

  // Linked projects — writable when mode === 'write'.
  for (const link of inputs.linkedProjects) {
    if (link.mode === 'write') {
      writeTargets.add(path.resolve(link.path));
    }
  }

  // Package-manager and toolchain dirs — only included if present on disk,
  // so the generated profile stays compact. The agent needs these so that
  // `pip install --user`, `npm i -g`, `brew install`, `cargo install`, etc.
  // behave the same as in a normal shell. Existing per-user secrets/config
  // (e.g. `~/.gnupg`, `~/.ssh`) remain protected by the deny rules below.
  for (const entry of TOOLCHAIN_WRITE_PATHS) {
    const resolved = entry.startsWith('/') ? entry : path.join(home, entry);
    let exists = false;
    try {
      exists = fs.existsSync(resolved);
    } catch {
      exists = false;
    }
    if (exists) writeTargets.add(resolved);
  }

  const writeLines = [...writeTargets]
    .sort()
    .map((p) => '  ' + quoteSubpath('subpath', p))
    .join('\n');

  // Empty deny-blocks are a Seatbelt syntax error. Guarantee at least one entry
  // so the template can always emit a valid (deny file-read* ...) form.
  const forbiddenPaths = inputs.forbiddenHomeSubpaths.length > 0
    ? inputs.forbiddenHomeSubpaths
    : ['.ssh'];

  // Library/Keychains is in the forbidden list to prevent linking, but must
  // NOT be denied in the sandbox — Claude Code needs keychain access for OAuth.
  // Keychain items have their own per-app ACLs so this doesn't expose other
  // apps' stored credentials.
  const sandboxForbidden = forbiddenPaths.filter((p) => p !== 'Library/Keychains');
  // Ensure we still have at least one entry
  const effectiveForbidden = sandboxForbidden.length > 0 ? sandboxForbidden : ['.ssh'];

  const denyLines = effectiveForbidden
    .map((sub) => '  ' + quoteSubpath('subpath', path.join(home, sub)))
    .join('\n');

  return `;; Cerebro sandbox profile — auto-generated, do not edit by hand.
;; Regenerated from sandbox settings before each Claude Code subprocess spawn.

(version 1)
(deny default)
(debug deny)

;; ── Process / IPC ──
(allow process-fork)
(allow process-exec)
(allow process-info*)
(allow signal (target self))
(allow signal (target children))
(allow mach-lookup)
(allow mach-register)
(allow ipc-posix-shm)
(allow ipc-posix-sem)
(allow sysctl-read)

;; ── Network ──
;; v1: allow all network. Domain allowlist is a follow-up (requires a proxy
;; or pf rules — outside the v1 scope).
(allow network*)

;; ── Pipes / PTY / ioctl ──
;; file-write-data covers stdout/stderr pipe writes and data writes to
;; already-open file descriptors. file-ioctl is needed by Node.js for
;; terminal/socket operations. pseudo-tty enables PTY for terminal output.
(allow file-write-data)
(allow file-ioctl)
(allow pseudo-tty)

;; ── File reads ──
;; Broad read access — Claude Code + Node.js read from many system and
;; user-library paths (toolchains, caches, auth state). The deny rules
;; below protect credentials and sensitive data.
(allow file-read* (subpath "/"))

;; ── File writes ──
(allow file-write*
${writeLines}
)

;; ── Forbidden zones (defence in depth) ──
;; These deny rules override the broad read-allow above for sensitive paths.
;; Write denies prevent modification even if the path falls inside an
;; allowed write subpath (e.g. ~/.local covers ~/.gnupg on some layouts).
(deny file-read*
${denyLines}
)
(deny file-write*
${denyLines}
)
`;
}
