/**
 * SSRF guard — rejects hostnames pointing at private/internal networks
 * or known cloud-metadata endpoints before any socket is opened.
 *
 * Two layers:
 *   - `isBlockedHost`     — synchronous check for IP literals (IPv4, IPv6,
 *                           bracketed, IPv4-mapped IPv6) and known-bad names.
 *   - `assertHostAllowed` — async; additionally resolves DNS names and blocks
 *                           any name that resolves to a private/internal IP
 *                           (e.g. `127.0.0.1.nip.io`).
 */

import { lookup } from 'node:dns/promises';

const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal']);

/**
 * Node's URL parser returns IPv6 hosts wrapped in brackets (`[::1]`) and
 * lower-cases them. Strip the brackets and normalise case so downstream
 * checks see a bare address.
 */
function normalizeHostname(hostname: string): string {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) {
    h = h.slice(1, -1);
  }
  return h;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number(p));
  if (nums.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = nums;
  if (a === 127) return true; // 127.0.0.0/8   loopback
  if (a === 10) return true; // 10.0.0.0/8     private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / metadata
  if (a === 0) return true; // 0.0.0.0/8      unspecified
  return false;
}

/**
 * Expand an IPv6 string into its eight 16-bit groups, handling `::`
 * compression and a trailing embedded IPv4 (`::ffff:127.0.0.1`).
 * Returns null if the input is not a parseable IPv6 address.
 */
function parseIPv6(input: string): number[] | null {
  // Drop any zone id (e.g. fe80::1%eth0).
  let s = input.toLowerCase();
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct);

  if (!s.includes(':')) return null;

  // Convert a trailing dotted-quad IPv4 into two hextets.
  if (s.includes('.')) {
    const lastColon = s.lastIndexOf(':');
    const v4 = s.slice(lastColon + 1);
    const octets = v4.split('.').map((o) => Number(o));
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
      return null;
    }
    const hex1 = ((octets[0] << 8) | octets[1]).toString(16);
    const hex2 = ((octets[2] << 8) | octets[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hex1}:${hex2}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];

  let groups: string[];
  if (halves.length === 1) {
    groups = head;
  } else {
    const missing = 8 - (head.length + tail.length);
    if (missing < 1) return null; // `::` must represent at least one group
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  }

  if (groups.length !== 8) return null;

  const parsed = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  if (parsed.some((g) => Number.isNaN(g))) return null;
  return parsed;
}

function isPrivateIPv6(input: string): boolean {
  const g = parseIPv6(input);
  if (!g) return false;

  // ::  unspecified
  if (g.every((x) => x === 0)) return true;
  // ::1 loopback
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
  // ::ffff:a.b.c.d  IPv4-mapped — re-check the embedded IPv4
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
    if (isPrivateIPv4(v4)) return true;
  }
  // fc00::/7  unique-local
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  return false;
}

/** True if `hostname` is an IP literal (no DNS resolution needed). */
export function isIpLiteral(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  return h.includes(':');
}

/**
 * Synchronous guard for IP literals and known-bad hostnames. Handles bracketed
 * and IPv4-mapped IPv6 so that `[::1]`, `[::ffff:127.0.0.1]`, `[::]`, link-local
 * and unique-local addresses are all rejected.
 */
export function isBlockedHost(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  if (BLOCKED_HOSTS.has(h)) return true;
  if (isPrivateIPv4(h)) return true;
  if (h.includes(':')) return isPrivateIPv6(h);
  return false;
}

/**
 * Full async guard: blocks IP literals via `isBlockedHost`, and for DNS names
 * resolves them and rejects if ANY resolved address is private/internal. This
 * closes name-based bypasses such as `127.0.0.1.nip.io`. A resolution failure
 * is left for the request layer to surface as a normal connection error.
 */
export async function assertHostAllowed(hostname: string): Promise<void> {
  if (isBlockedHost(hostname)) {
    throw new Error(`Requests to private/internal addresses are not allowed: ${hostname}`);
  }
  if (isIpLiteral(hostname)) return;

  let results: Array<{ address: string }>;
  try {
    results = await lookup(normalizeHostname(hostname), { all: true });
  } catch {
    return;
  }

  for (const { address } of results) {
    if (isBlockedHost(address)) {
      throw new Error(
        `Requests to private/internal addresses are not allowed: ${hostname} resolves to ${address}`,
      );
    }
  }
}
