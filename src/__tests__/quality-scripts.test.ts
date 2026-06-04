import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// Regression guard for #53: the repository's own quality scripts must pass on
// the checked-in tree, otherwise CI/preflight cannot use them as a gate.
describe('quality scripts', () => {
  const runScript = (script: string) => {
    execFileSync('npm', ['run', script], {
      cwd: process.cwd(),
      stdio: 'pipe',
      timeout: 300_000,
    });
  };

  // These shell out to eslint/prettier over the whole tree, which takes
  // longer than vitest's default 5s per-test timeout, so raise it.
  it('format:check passes on the checked-in tree', () => {
    expect(() => runScript('format:check')).not.toThrow();
  }, 300_000);

  it('lint passes on the checked-in tree', () => {
    expect(() => runScript('lint')).not.toThrow();
  }, 300_000);
});
