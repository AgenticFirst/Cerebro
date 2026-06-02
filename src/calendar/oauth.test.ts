import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';

// oauth.ts imports `electron` for shell.openExternal; stub it for the node env.
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));

import { generatePkce, generateState } from './oauth';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('PKCE', () => {
  it('derives an S256 challenge from the verifier', () => {
    const { verifier, challenge } = generatePkce();
    // verifier is URL-safe base64 with no padding
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    const expected = base64url(crypto.createHash('sha256').update(verifier).digest());
    expect(challenge).toBe(expected);
  });

  it('produces unique verifiers and states', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(generateState()).not.toBe(generateState());
  });
});
