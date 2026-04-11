/**
 * Generates a macOS Seatbelt (sandbox-exec) profile for the Claude Code
 * subprocess. Writes are narrow (workspace + tmp + ~/.claude + RW-linked
 * projects); reads are broad enough for Node/npm/pip/rust toolchains to run.
 *
 * Forbidden zones are passed in from the caller (sourced from the backend
 * validation list) rather than hardcoded here — a single source of truth.
 */

import os from 'node:os';
import path from 'node:path';
import type { SandboxConfig } from './types';

// Read-allow paths under the user's home. Needed so Node/npm/pip/rust toolchains
// function under the sandbox. Writes to these are NOT granted.
const HOME_READ_SUBDIRS: readonly string[] = [
  '.nvm',
  '.npm',
  '.node_modules',
  '.cache',
  '.cargo',
  '.rustup',
  '.pyenv',
  '.local',
  '.asdf',
  '.config',
  '.npmrc',
  '.yarnrc',
  '.yarn',
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

  const readTargets = new Set<string>();
  const writeTargets = new Set<string>();

  // Baseline writable targets.
  writeTargets.add(workspace);
  writeTargets.add(cerebroData);
  writeTargets.add(path.join(home, '.claude'));
  writeTargets.add('/private/var/folders');
  writeTargets.add('/private/tmp');
  writeTargets.add('/private/var/tmp');

  // Linked projects — all readable, writable only when mode === 'write'.
  for (const link of inputs.linkedProjects) {
    const resolved = path.resolve(link.path);
    readTargets.add(resolved);
    if (link.mode === 'write') {
      writeTargets.add(resolved);
    }
  }

  // Everything we can write, we can also read.
  for (const target of writeTargets) {
    readTargets.add(target);
  }

  // System toolchain read access.
  const systemReads = [
    '/System',
    '/usr',
    '/bin',
    '/sbin',
    '/Library',
    '/opt',
    '/private/var/folders',
    '/private/tmp',
    '/private/var/tmp',
    '/private/etc',
    '/private/var/db/mds',
    '/private/var/db/timezone',
    '/dev',
    '/Applications',
  ];
  for (const p of systemReads) readTargets.add(p);

  for (const sub of HOME_READ_SUBDIRS) {
    readTargets.add(path.join(home, sub));
  }

  const readLines = [...readTargets]
    .sort()
    .map((p) => '  ' + quoteSubpath('subpath', p))
    .join('\n');

  const writeLines = [...writeTargets]
    .sort()
    .map((p) => '  ' + quoteSubpath('subpath', p))
    .join('\n');

  // Empty deny-blocks are a Seatbelt syntax error. Guarantee at least one entry
  // so the template can always emit a valid (deny file-read* ...) form.
  const forbiddenPaths = inputs.forbiddenHomeSubpaths.length > 0
    ? inputs.forbiddenHomeSubpaths
    : ['.ssh'];
  const denyLines = forbiddenPaths
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

;; ── File reads ──
(allow file-read*
${readLines}
)

;; ── File writes ──
(allow file-write*
${writeLines}
)

;; ── Forbidden zones (defence in depth) ──
;; The base policy is already deny-default, so these deny lines only matter
;; if someone adds an allow rule above that accidentally covers a sensitive
;; path. Keep them as a backstop.
(deny file-read*
${denyLines}
)
(deny file-write*
${denyLines}
)
`;
}
