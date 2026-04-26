/**
 * Acceptance tests for the release pipeline configuration.
 *
 * These don't run any builds — they assert the static config files match the
 * shape we expect, so a stray edit can't silently break the release.
 *   - .github/workflows/release.yml ........ correct trigger + matrix + token
 *   - forge.config.ts ...................... correct makers + GitHub publisher
 *   - package.json ......................... repository URL + version + deps
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

// ── Release workflow ────────────────────────────────────────────

describe('.github/workflows/release.yml', () => {
  const yml = read('.github/workflows/release.yml');

  it('triggers on v* tag pushes (not on every commit to main)', () => {
    // Tag-trigger block must be present; branch trigger must NOT be.
    expect(yml).toMatch(/tags:\s*\n\s*-\s*['"]?v\*['"]?/);
    expect(yml).not.toMatch(/branches:\s*\n\s*-\s*main/);
  });

  it('builds in parallel on macos, windows, and ubuntu runners', () => {
    expect(yml).toMatch(/os:\s*\[macos-latest,\s*windows-latest,\s*ubuntu-latest\]/);
  });

  it('grants contents:write so the Forge publisher can create releases', () => {
    expect(yml).toMatch(/permissions:\s*\n\s*contents:\s*write/);
  });

  it('passes GITHUB_TOKEN through to the publish step', () => {
    expect(yml).toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
  });

  it('runs npm run publish (the Forge GitHub publisher entry point)', () => {
    expect(yml).toMatch(/run:\s*npm run publish/);
  });

  it('installs Linux build tools (fakeroot/dpkg/rpm) only on the Ubuntu runner', () => {
    expect(yml).toMatch(/if:\s*runner\.os\s*==\s*['"]Linux['"]/);
    expect(yml).toMatch(/fakeroot/);
    expect(yml).toMatch(/dpkg/);
    expect(yml).toMatch(/rpm/);
  });

  it('pre-downloads voice models so the postinstall hook short-circuits in CI', () => {
    expect(yml).toMatch(/python3 scripts\/download-voice-models\.py/);
  });

  it('also exposes a workflow_dispatch trigger for manual releases', () => {
    expect(yml).toContain('workflow_dispatch');
  });

  it('validates that the pushed tag matches package.json version', () => {
    // Without this check, a tag/version mismatch ships artifacts named
    // for the WRONG version, and the in-app updater never stops nagging.
    expect(yml).toMatch(/Verify tag matches package\.json version/i);
    expect(yml).toMatch(/PKG_VERSION/);
    expect(yml).toMatch(/exit 1/);
  });

  it('rebuilds appdmg native deps on the macOS runner so the DMG maker works', () => {
    expect(yml).toMatch(/npm rebuild fs-xattr macos-alias/);
  });
});

// ── Forge config ────────────────────────────────────────────────

describe('forge.config.ts', () => {
  const cfg = read('forge.config.ts');

  it('imports the GitHub publisher', () => {
    expect(cfg).toMatch(
      /import\s*\{\s*PublisherGithub\s*\}\s*from\s*['"]@electron-forge\/publisher-github['"]/,
    );
  });

  it('targets the AgenticFirst/Cerebro repo', () => {
    expect(cfg).toMatch(/owner:\s*['"]AgenticFirst['"]/);
    expect(cfg).toMatch(/name:\s*['"]Cerebro['"]/);
  });

  it('publishes as draft (so we can review release notes before going public)', () => {
    expect(cfg).toMatch(/draft:\s*true/);
  });

  it('keeps Mac (DMG + ZIP), Windows (Squirrel), and Linux (deb/rpm/AppImage) makers', () => {
    expect(cfg).toMatch(/new MakerDMG/);
    expect(cfg).toMatch(/new MakerZIP/);
    expect(cfg).toMatch(/new MakerSquirrel/);
    expect(cfg).toMatch(/new MakerDeb/);
    expect(cfg).toMatch(/new MakerRpm/);
    expect(cfg).toMatch(/new MakerAppImage/);
  });
});

// ── package.json ────────────────────────────────────────────────

describe('package.json', () => {
  const pkg = JSON.parse(read('package.json')) as {
    name: string;
    version: string;
    repository?: { type: string; url: string };
    devDependencies: Record<string, string>;
    dependencies: Record<string, string>;
  };

  it('declares the repository URL (Forge publisher reads this as a fallback)', () => {
    expect(pkg.repository?.url).toMatch(/AgenticFirst\/Cerebro/);
  });

  it('uses a valid semver version (the updater compares against this)', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });

  it('depends on semver at runtime (used by the updater for version comparison)', () => {
    expect(pkg.dependencies['semver']).toBeDefined();
  });

  it('has the GitHub publisher and AppImage maker as dev dependencies', () => {
    expect(pkg.devDependencies['@electron-forge/publisher-github']).toBeDefined();
    expect(pkg.devDependencies['@reforged/maker-appimage']).toBeDefined();
  });

  it('has a verify:build script that the pre-push hook can run', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    expect(scripts['verify:build']).toBeDefined();
  });
});

// ── Binary naming consistency ───────────────────────────────────
//
// THIS is the test that would have caught the v0.1.0 release failure.
//
// Forge's deb/rpm/AppImage makers all look for an executable matching
// `package.json.name` (lowercase) at the root of the packaged app dir.
// Without `packagerConfig.executableName`, Forge's packager produces a
// binary named after `packagerConfig.name` (capital `Cerebro`) — and the
// makers can't find it.
//
// Mac and Windows succeed silently because they don't care about the case
// (Mac wraps it in an .app bundle, Windows in an .exe), so this only
// surfaces on the Linux runner. Catching it locally avoids a 4-minute CI
// round-trip per fix attempt.

describe('forge.config.ts — binary naming invariants', () => {
  const cfg = read('forge.config.ts');
  const pkg = JSON.parse(read('package.json')) as { name: string };

  it('sets packagerConfig.executableName (otherwise Linux makers cannot find the binary)', () => {
    expect(cfg).toMatch(/executableName:\s*['"][^'"]+['"]/);
  });

  it('uses an executableName that matches package.json.name (the default Forge makers look for)', () => {
    const match = cfg.match(/executableName:\s*['"]([^'"]+)['"]/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(pkg.name);
  });

  it('uses a lowercase executableName (Linux + POSIX convention; AppImage rejects spaces)', () => {
    const match = cfg.match(/executableName:\s*['"]([^'"]+)['"]/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(match![1].toLowerCase());
    expect(match![1]).not.toMatch(/\s/);
  });
});
