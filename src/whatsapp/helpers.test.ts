import { describe, it, expect } from 'vitest';
import { inboundPhone, isAllowed, normalizePhone } from './helpers';

describe('inboundPhone', () => {
  it('resolves a classic <pn>@s.whatsapp.net sender to bare digits', () => {
    expect(inboundPhone({ remoteJid: '573181445541@s.whatsapp.net' })).toBe('573181445541');
  });

  it('drops a device suffix on a classic sender', () => {
    expect(inboundPhone({ remoteJid: '573181445541:7@s.whatsapp.net' })).toBe('573181445541');
  });

  it('resolves an @lid sender via senderPn, NOT the opaque lid value', () => {
    // Regression: WhatsApp now addresses senders by linked-id. The lid
    // (12099999@lid) is not a phone — the real number rides along in senderPn.
    // The old handler dropped these before any allowlist log ("no llega").
    expect(
      inboundPhone({
        remoteJid: '12099999999999@lid',
        senderPn: '573181445541@s.whatsapp.net',
      }),
    ).toBe('573181445541');
  });

  it('falls back to participantPn when senderPn is absent on an @lid key', () => {
    expect(
      inboundPhone({
        remoteJid: '12099999999999@lid',
        participantPn: '491701234567@s.whatsapp.net',
      }),
    ).toBe('491701234567');
  });

  it('returns "" for an @lid message with no PN attribute (cannot resolve)', () => {
    expect(inboundPhone({ remoteJid: '12099999999999@lid' })).toBe('');
  });

  it('returns "" for groups, broadcast, and empty keys', () => {
    expect(inboundPhone({ remoteJid: '120363000000000000@g.us' })).toBe('');
    expect(inboundPhone({ remoteJid: 'status@broadcast' })).toBe('');
    expect(inboundPhone({ remoteJid: '' })).toBe('');
    expect(inboundPhone(null)).toBe('');
    expect(inboundPhone(undefined)).toBe('');
  });

  it('an @lid sender resolved via senderPn matches the digits-based allowlist', () => {
    const phone = inboundPhone({
      remoteJid: '12099999999999@lid',
      senderPn: '573181445541@s.whatsapp.net',
    });
    expect(isAllowed(phone, ['573181445541'])).toBe(true);
    // Sanity: normalizing the raw lid would NOT have matched.
    expect(isAllowed(normalizePhone('12099999999999@lid'), ['573181445541'])).toBe(false);
  });
});
