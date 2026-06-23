import { describe, it, expect } from 'vitest';
import {
  expertAgentName,
  slugify,
  hashSuffix,
  isCerebroExpert,
  CEREBRO_EXPERT_ID,
} from './agent-name';

describe('expertAgentName', () => {
  it('matches the exact directory name the installer wrote for a real user expert', () => {
    // Regression: user created "TikTok Strategist" in prod. DB slug was null,
    // installer wrote memory to `tiktok-strategist-z8pnvt`, UI used
    // `expert.slug` (null) and showed "Memory will be created when this expert
    // first runs" even though files existed on disk.
    // The UI now computes the name the same way the installer does; both must
    // produce this exact string forever.
    expect(expertAgentName('56c2c4c2b71d4fd49f8256a44e0da693', 'TikTok Strategist')).toBe(
      'tiktok-strategist-z8pnvt',
    );
  });

  it('is deterministic on the id — same id+name always produces same dir', () => {
    const a = expertAgentName('abc-123', 'Some Expert');
    const b = expertAgentName('abc-123', 'Some Expert');
    expect(a).toBe(b);
  });

  it('produces different dirs for different ids even with identical names', () => {
    const a = expertAgentName('id-one', 'Coach');
    const b = expertAgentName('id-two', 'Coach');
    expect(a).not.toBe(b);
  });

  it('produces different dirs when an expert is renamed (by design)', () => {
    // Rename migrates: installer deletes the old dir and writes a new one.
    // If this invariant changes we need to re-validate the rename path.
    const id = 'stable-id';
    expect(expertAgentName(id, 'Fitness Coach')).not.toBe(expertAgentName(id, 'Running Coach'));
  });

  it('strips diacritics and non-alphanumerics consistently', () => {
    expect(slugify('Café — naïve résumé')).toBe('cafe-naive-resume');
  });

  it('falls back to "expert" when the name slugifies to empty', () => {
    const name = '!!!';
    expect(expertAgentName('id', name).startsWith('expert-')).toBe(true);
  });

  it('caps the slug portion at 48 chars (hash suffix still appended)', () => {
    const long = 'a'.repeat(100);
    const result = expertAgentName('id', long);
    const [slug, suffix] = [result.slice(0, -7), result.slice(-6)];
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(suffix).toMatch(/^[a-z0-9]{6}$/);
  });

  it('hashSuffix is always 6 chars of lowercase base36', () => {
    expect(hashSuffix('')).toMatch(/^[0-9a-z]{6}$/);
    expect(hashSuffix('x')).toMatch(/^[0-9a-z]{6}$/);
    expect(hashSuffix('very-long-identifier-' + 'a'.repeat(200))).toMatch(/^[0-9a-z]{6}$/);
  });
});

describe('isCerebroExpert / CEREBRO_EXPERT_ID', () => {
  it("the well-known id is exactly 'cerebro' (mirrors backend CEREBRO_EXPERT_ID)", () => {
    // This literal is hard-coded in the backend seeder, the runtime routing
    // guard, the installer skip, and list-experts.sh. If it ever drifts here,
    // task assignment to Cerebro silently stops routing to the orchestrator.
    expect(CEREBRO_EXPERT_ID).toBe('cerebro');
  });

  it('matches the bare id string', () => {
    expect(isCerebroExpert('cerebro')).toBe(true);
    expect(isCerebroExpert(CEREBRO_EXPERT_ID)).toBe(true);
  });

  it('matches an expert-shaped object by id', () => {
    expect(isCerebroExpert({ id: 'cerebro' })).toBe(true);
    expect(isCerebroExpert({ id: 'e-123' })).toBe(false);
  });

  it('does not match other experts or empty values', () => {
    expect(isCerebroExpert('e-123')).toBe(false);
    expect(isCerebroExpert('')).toBe(false);
    expect(isCerebroExpert(null)).toBe(false);
    expect(isCerebroExpert(undefined)).toBe(false);
  });

  it('is case-sensitive (only the exact id routes to the orchestrator)', () => {
    expect(isCerebroExpert('Cerebro')).toBe(false);
    expect(isCerebroExpert('CEREBRO')).toBe(false);
  });
});
