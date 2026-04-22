/**
 * SSRF guard — rejects hostnames pointing at private/internal networks
 * or known cloud-metadata endpoints before any socket is opened.
 */

const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal']);

function isPrivateIP(hostname: string): boolean {
  const parts = hostname.split('.').map(Number);
  if (parts.length === 4 && parts.every((p) => !Number.isNaN(p))) {
    if (parts[0] === 127) return true;                                          // 127.0.0.0/8
    if (parts[0] === 10) return true;                                           // 10.0.0.0/8
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;      // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true;                      // 192.168.0.0/16
    if (parts[0] === 169 && parts[1] === 254) return true;                      // 169.254.0.0/16
    if (parts[0] === 0) return true;                                            // 0.0.0.0/8
  }
  if (hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd')) return true;
  return false;
}

export function isBlockedHost(hostname: string): boolean {
  return BLOCKED_HOSTS.has(hostname) || isPrivateIP(hostname);
}
