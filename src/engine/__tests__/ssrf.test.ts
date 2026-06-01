import { describe, it, expect } from 'vitest';
import { isBlockedHost } from '../actions/utils/ssrf';

describe('isBlockedHost', () => {
  it('blocks the literal "localhost"', () => {
    expect(isBlockedHost('localhost')).toBe(true);
  });

  it('blocks cloud metadata hostname', () => {
    expect(isBlockedHost('metadata.google.internal')).toBe(true);
  });

  it('blocks 127.0.0.0/8 (loopback)', () => {
    expect(isBlockedHost('127.0.0.1')).toBe(true);
    expect(isBlockedHost('127.1.2.3')).toBe(true);
  });

  it('blocks 10.0.0.0/8 (private)', () => {
    expect(isBlockedHost('10.0.0.1')).toBe(true);
    expect(isBlockedHost('10.255.255.255')).toBe(true);
  });

  it('blocks 172.16.0.0/12 (private)', () => {
    expect(isBlockedHost('172.16.0.1')).toBe(true);
    expect(isBlockedHost('172.31.255.255')).toBe(true);
  });

  it('does not block 172.15.x.x or 172.32.x.x (outside /12)', () => {
    expect(isBlockedHost('172.15.0.1')).toBe(false);
    expect(isBlockedHost('172.32.0.1')).toBe(false);
  });

  it('blocks 192.168.0.0/16 (private)', () => {
    expect(isBlockedHost('192.168.0.1')).toBe(true);
    expect(isBlockedHost('192.168.255.255')).toBe(true);
  });

  it('blocks 169.254.0.0/16 (link-local / AWS/Azure metadata)', () => {
    expect(isBlockedHost('169.254.169.254')).toBe(true);
  });

  it('blocks 0.0.0.0/8', () => {
    expect(isBlockedHost('0.0.0.0')).toBe(true);
  });

  it('blocks IPv6 loopback', () => {
    expect(isBlockedHost('::1')).toBe(true);
  });

  it('blocks IPv6 unique local addresses (fc00::/7)', () => {
    expect(isBlockedHost('fc00::1')).toBe(true);
    expect(isBlockedHost('fd12:3456:789a::1')).toBe(true);
  });

  it('allows a public hostname', () => {
    expect(isBlockedHost('example.com')).toBe(false);
    expect(isBlockedHost('api.github.com')).toBe(false);
  });

  it('allows a public IPv4 address', () => {
    expect(isBlockedHost('8.8.8.8')).toBe(false);
    expect(isBlockedHost('1.1.1.1')).toBe(false);
  });
});

// Regression coverage for issue #19. Node's URL parser wraps IPv6 hosts in
// brackets ("[::1]") and normalises IPv4-mapped forms to hex
// ("[::ffff:7f00:1]"), so the old `hostname === '::1'` check never fired and
// mapped / unspecified IPv6 slipped straight through the guard.
describe('isBlockedHost — IPv6 and bracketed-host bypasses (issue #19)', () => {
  const host = (u: string) => new URL(u).hostname;

  it('blocks bracketed IPv6 loopback and the unspecified address', () => {
    expect(isBlockedHost(host('http://[::1]/'))).toBe(true); // "[::1]"
    expect(isBlockedHost(host('http://[::]/'))).toBe(true); // "[::]"
  });

  it('blocks IPv4-mapped IPv6 loopback and cloud-metadata', () => {
    // url.hostname is "[::ffff:7f00:1]" / "[::ffff:a9fe:a9fe]" after Node normalises.
    expect(isBlockedHost(host('http://[::ffff:127.0.0.1]/'))).toBe(true);
    expect(isBlockedHost(host('http://[::ffff:169.254.169.254]/'))).toBe(true);
  });

  it('blocks IPv6 link-local (fe80::/10), bare and bracketed', () => {
    expect(isBlockedHost('fe80::1')).toBe(true);
    expect(isBlockedHost(host('http://[fe80::1]/'))).toBe(true);
  });

  it('still blocks bracketed ULA (fc00::/7)', () => {
    expect(isBlockedHost(host('http://[fc00::1]/'))).toBe(true);
  });

  it('allows public hosts and public IPv6', () => {
    expect(isBlockedHost(host('http://example.com/'))).toBe(false);
    expect(isBlockedHost('2606:4700:4700::1111')).toBe(false); // public resolver
    expect(isBlockedHost(host('http://[2606:4700:4700::1111]/'))).toBe(false);
  });
});
