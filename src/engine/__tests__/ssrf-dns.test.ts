import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DNS so the resolution guard is deterministic and offline. This is what
// catches DNS-name SSRF bypasses like `127.0.0.1.nip.io` (issue #19): the name
// itself looks public, but it resolves to a private address.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup } from 'node:dns/promises';
import { assertHostAllowed } from '../actions/utils/ssrf';

const mockedLookup = lookup as unknown as ReturnType<typeof vi.fn>;

describe('assertHostAllowed — DNS-name SSRF guard (issue #19)', () => {
  beforeEach(() => mockedLookup.mockReset());

  it('rejects a public-looking DNS name that resolves to loopback', async () => {
    mockedLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(assertHostAllowed('127.0.0.1.nip.io')).rejects.toThrow(
      /private\/internal addresses/,
    );
  });

  it('rejects a DNS name that resolves to cloud-metadata (169.254.169.254)', async () => {
    mockedLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    await expect(assertHostAllowed('metadata.attacker.example')).rejects.toThrow(
      /private\/internal addresses/,
    );
  });

  it('rejects a DNS name that resolves to an IPv6 loopback', async () => {
    mockedLookup.mockResolvedValue([{ address: '::1', family: 6 }]);
    await expect(assertHostAllowed('loopback.attacker.example')).rejects.toThrow(
      /private\/internal addresses/,
    );
  });

  it('rejects when ANY resolved address is private (DNS round-robin)', async () => {
    mockedLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    await expect(assertHostAllowed('split-horizon.example')).rejects.toThrow(
      /private\/internal addresses/,
    );
  });

  it('allows a DNS name that resolves only to public addresses', async () => {
    mockedLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(assertHostAllowed('example.com')).resolves.toBeUndefined();
  });

  it('does not resolve DNS for an IP literal (already covered by isBlockedHost)', async () => {
    await expect(assertHostAllowed('8.8.8.8')).resolves.toBeUndefined();
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('rejects an IP-literal that is itself private without resolving', async () => {
    await expect(assertHostAllowed('127.0.0.1')).rejects.toThrow(/private\/internal addresses/);
    expect(mockedLookup).not.toHaveBeenCalled();
  });
});
