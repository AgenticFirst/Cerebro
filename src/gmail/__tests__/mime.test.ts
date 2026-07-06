import { describe, it, expect } from 'vitest';
import { buildRawMessage, encodeHeaderValue, base64UrlEncode } from '../mime';

function decodeRaw(raw: string): string {
  return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

describe('buildRawMessage', () => {
  it('builds a simple text message with the right headers', () => {
    const raw = buildRawMessage({
      from: 'Carlos <carlos@example.com>',
      to: ['alice@example.com'],
      subject: 'Hello',
      text: 'Hi Alice',
    });
    // base64url alphabet only
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const msg = decodeRaw(raw);
    expect(msg).toContain('From: Carlos <carlos@example.com>');
    expect(msg).toContain('To: alice@example.com');
    expect(msg).toContain('Subject: Hello');
    expect(msg).toContain('MIME-Version: 1.0');
    expect(msg).toContain('Content-Type: text/plain; charset="UTF-8"');
    // body is base64-encoded
    expect(msg).toContain(Buffer.from('Hi Alice', 'utf8').toString('base64'));
  });

  it('joins multiple recipients and includes Cc/Bcc only when present', () => {
    const msg = decodeRaw(
      buildRawMessage({
        from: 'c@x.com',
        to: ['a@x.com', 'b@x.com'],
        cc: ['cc@x.com'],
        subject: 's',
        text: 't',
      }),
    );
    expect(msg).toContain('To: a@x.com, b@x.com');
    expect(msg).toContain('Cc: cc@x.com');
    expect(msg).not.toContain('Bcc:');
  });

  it('adds In-Reply-To + References with angle brackets for replies', () => {
    const msg = decodeRaw(
      buildRawMessage({
        from: 'c@x.com',
        to: ['a@x.com'],
        subject: 'Re: thread',
        text: 'reply',
        inReplyTo: 'abc123@mail.gmail.com',
        references: '<root@mail.gmail.com>',
      }),
    );
    expect(msg).toContain('In-Reply-To: <abc123@mail.gmail.com>');
    expect(msg).toContain('References: <root@mail.gmail.com> <abc123@mail.gmail.com>');
  });

  it('builds multipart/alternative when html is provided', () => {
    const msg = decodeRaw(
      buildRawMessage({
        from: 'c@x.com',
        to: ['a@x.com'],
        subject: 's',
        text: 'plain',
        html: '<b>rich</b>',
      }),
    );
    expect(msg).toContain('Content-Type: multipart/alternative');
    expect(msg).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(msg).toContain('Content-Type: text/html; charset="UTF-8"');
  });

  it('wraps everything in multipart/mixed when attachments are present', () => {
    const content = Buffer.from('fake-pdf-bytes').toString('base64');
    const msg = decodeRaw(
      buildRawMessage({
        from: 'c@x.com',
        to: ['a@x.com'],
        subject: 's',
        text: 'see attached',
        attachments: [{ filename: 'doc.pdf', mimeType: 'application/pdf', contentBase64: content }],
      }),
    );
    expect(msg).toContain('Content-Type: multipart/mixed');
    expect(msg).toContain('Content-Disposition: attachment; filename="doc.pdf"');
    expect(msg).toContain(content);
  });

  it('RFC 2047-encodes non-ASCII subjects', () => {
    const msg = decodeRaw(
      buildRawMessage({
        from: 'c@x.com',
        to: ['a@x.com'],
        subject: 'Reunión mañana',
        text: 'hola',
      }),
    );
    const encoded = `=?UTF-8?B?${Buffer.from('Reunión mañana', 'utf8').toString('base64')}?=`;
    expect(msg).toContain(`Subject: ${encoded}`);
  });
});

describe('encodeHeaderValue', () => {
  it('passes ASCII through untouched', () => {
    expect(encodeHeaderValue('Plain subject 123')).toBe('Plain subject 123');
  });
  it('B-encodes non-ASCII', () => {
    expect(encodeHeaderValue('café')).toBe(
      `=?UTF-8?B?${Buffer.from('café', 'utf8').toString('base64')}?=`,
    );
  });
});

describe('base64UrlEncode', () => {
  it('produces URL-safe output without padding', () => {
    const out = base64UrlEncode(Buffer.from([251, 255, 190, 1, 2]));
    expect(out).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(out).not.toContain('=');
  });
});
