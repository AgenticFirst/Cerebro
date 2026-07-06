/**
 * RFC 2822 MIME builder for Gmail's `messages.send` raw format.
 *
 * Gmail expects the full message base64url-encoded in `Message.raw`. Replies
 * only thread correctly when all three hold: the send carries the `threadId`,
 * the `References`/`In-Reply-To` headers point at the message being answered,
 * and the Subject matches the thread's ("Re: " prefix allowed).
 *
 * Pure functions — unit-tested without network or Electron.
 */

export interface MimeInput {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  /** Message-ID of the message being replied to (angle brackets included or not). */
  inReplyTo?: string;
  /** Existing References header value of the replied-to message, if any. */
  references?: string;
  attachments?: Array<{ filename: string; mimeType: string; contentBase64: string }>;
}

export function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 2047 B-encoding for non-ASCII header values (Subject, display names). */
export function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function angleBracket(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith('<') ? trimmed : `<${trimmed}>`;
}

/** Fold a base64 body into 76-char lines per RFC 2045. */
function foldBase64(b64: string): string {
  return b64.replace(/(.{76})/g, '$1\r\n');
}

function textPart(content: string, contentType: string): string {
  return [
    `Content-Type: ${contentType}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    foldBase64(Buffer.from(content, 'utf8').toString('base64')),
  ].join('\r\n');
}

function boundary(tag: string): string {
  // Deterministic-per-call unique boundary; RFC only needs it absent from content.
  return `cerebro_${tag}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Build the full RFC 2822 message and return it base64url-encoded, ready for
 * the Gmail API `raw` field.
 */
export function buildRawMessage(input: MimeInput): string {
  const headers: string[] = [];
  headers.push(`From: ${input.from}`);
  headers.push(`To: ${input.to.join(', ')}`);
  if (input.cc?.length) headers.push(`Cc: ${input.cc.join(', ')}`);
  if (input.bcc?.length) headers.push(`Bcc: ${input.bcc.join(', ')}`);
  headers.push(`Subject: ${encodeHeaderValue(input.subject)}`);
  if (input.inReplyTo) {
    const ref = angleBracket(input.inReplyTo);
    headers.push(`In-Reply-To: ${ref}`);
    const refs = input.references ? `${input.references.trim()} ${ref}` : ref;
    headers.push(`References: ${refs}`);
  }
  headers.push('MIME-Version: 1.0');

  // Body: text-only → single part; text+html → multipart/alternative;
  // any attachments → multipart/mixed wrapping the body.
  let bodySection: string;
  if (input.html) {
    const alt = boundary('alt');
    bodySection = [
      `Content-Type: multipart/alternative; boundary="${alt}"`,
      '',
      `--${alt}`,
      textPart(input.text, 'text/plain'),
      `--${alt}`,
      textPart(input.html, 'text/html'),
      `--${alt}--`,
    ].join('\r\n');
  } else {
    bodySection = textPart(input.text, 'text/plain');
  }

  let message: string;
  if (input.attachments?.length) {
    const mixed = boundary('mix');
    const attachmentParts = input.attachments.map((a) =>
      [
        `--${mixed}`,
        `Content-Type: ${a.mimeType}; name="${encodeHeaderValue(a.filename)}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${encodeHeaderValue(a.filename)}"`,
        '',
        foldBase64(a.contentBase64.replace(/\s/g, '')),
      ].join('\r\n'),
    );
    message = [
      ...headers,
      `Content-Type: multipart/mixed; boundary="${mixed}"`,
      '',
      `--${mixed}`,
      bodySection,
      ...attachmentParts,
      `--${mixed}--`,
      '',
    ].join('\r\n');
  } else {
    message = [...headers, bodySection].join('\r\n');
  }

  return base64UrlEncode(Buffer.from(message, 'utf8'));
}
