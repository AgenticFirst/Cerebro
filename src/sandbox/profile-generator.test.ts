import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { generateProfile } from './profile-generator';

describe('generateProfile — toolchain write paths', () => {
  const realExistsSync = fs.existsSync;

  beforeEach(() => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
      // Pretend every toolchain dir is present so the test asserts on the
      // generator's intent, not the host machine's incidental layout.
      const s = p.toString();
      if (s.includes('Library/Python') || s.includes('/.npm') || s.includes('/.cargo') ||
          s.includes('homebrew') || s.includes('/.cache') || s.includes('/.config') ||
          s.includes('/.pyenv') || s.includes('/.rustup') || s.includes('/go') ||
          s.includes('/.deno') || s.includes('/.bun') || s.includes('/.nvm') ||
          s.includes('/.yarn') || s.includes('/.local/share')) {
        return true;
      }
      return realExistsSync(p);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes the standard package-manager dirs in the writable list', () => {
    const profile = generateProfile({
      workspacePath: '/tmp/workspace',
      cerebroDataDir: '/tmp/cerebro-data',
      linkedProjects: [],
      forbiddenHomeSubpaths: ['.ssh', '.gnupg'],
    });
    const home = os.homedir();
    expect(profile).toContain(`${home}/Library/Python`);
    expect(profile).toContain(`${home}/.npm`);
    expect(profile).toContain(`${home}/.cargo`);
    expect(profile).toContain(`${home}/.cache`);
    expect(profile).toContain('/opt/homebrew/Cellar');
  });

  it('does not include toolchain dirs that are absent from disk', () => {
    vi.restoreAllMocks();
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const profile = generateProfile({
      workspacePath: '/tmp/workspace',
      cerebroDataDir: '/tmp/cerebro-data',
      linkedProjects: [],
      forbiddenHomeSubpaths: ['.ssh'],
    });
    expect(profile).not.toContain('/Library/Python');
    expect(profile).not.toContain('/.cargo');
    expect(profile).not.toContain('/opt/homebrew/Cellar');
  });

  it('still denies the forbidden subpaths regardless of writable list growth', () => {
    const profile = generateProfile({
      workspacePath: '/tmp/workspace',
      cerebroDataDir: '/tmp/cerebro-data',
      linkedProjects: [],
      forbiddenHomeSubpaths: ['.ssh', '.gnupg'],
    });
    const home = os.homedir();
    // .ssh is denied; .config is allowed (and .config doesn't shadow .ssh).
    expect(profile).toContain(`(deny file-read*\n  (subpath "${home}/.ssh")\n  (subpath "${home}/.gnupg")\n)`);
  });
});
