/**
 * run_command allowlist — isolated from the action module so the renderer
 * bundle can import it without pulling in `node:child_process`.
 */

export const ALLOWED_COMMANDS: readonly string[] = [
  'git', 'gh', 'npm', 'npx', 'pip',
  'claude', 'bun', 'pnpm', 'yarn', 'cargo', 'make', 'docker',
  'ls', 'cat', 'echo', 'curl', 'wget', 'jq',
];
