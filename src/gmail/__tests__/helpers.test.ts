import { describe, it, expect } from 'vitest';
import {
  extractAddress,
  matchesGmailTrigger,
  parseGmailTriggerRoutine,
  buildGmailTriggerPayload,
} from '../helpers';
import type { GmailMessageSummary } from '../types';

function msg(overrides: Partial<GmailMessageSummary> = {}): GmailMessageSummary {
  return {
    id: 'm1',
    threadId: 't1',
    from: 'Alice Smith <alice@acme.com>',
    to: 'me@example.com',
    subject: 'Invoice #42 overdue',
    snippet: 'Please check…',
    receivedAt: '2026-07-04T10:00:00.000Z',
    labelIds: ['INBOX', 'UNREAD'],
    unread: true,
    hasAttachments: false,
    ...overrides,
  };
}

describe('extractAddress', () => {
  it('pulls the address out of a display-name header', () => {
    expect(extractAddress('Alice Smith <Alice@Acme.com>')).toBe('alice@acme.com');
  });
  it('passes bare addresses through', () => {
    expect(extractAddress('bob@x.com')).toBe('bob@x.com');
  });
});

describe('matchesGmailTrigger', () => {
  it('matches anyone with *', () => {
    expect(matchesGmailTrigger({ from: '*' }, msg())).toBe(true);
  });
  it('matches exact sender case-insensitively', () => {
    expect(matchesGmailTrigger({ from: 'ALICE@acme.com' }, msg())).toBe(true);
    expect(matchesGmailTrigger({ from: 'bob@acme.com' }, msg())).toBe(false);
  });
  it('matches @domain suffixes', () => {
    expect(matchesGmailTrigger({ from: '@acme.com' }, msg())).toBe(true);
    expect(matchesGmailTrigger({ from: '@other.com' }, msg())).toBe(false);
  });
  it('applies subject_contains case-insensitively', () => {
    expect(matchesGmailTrigger({ from: '*', subject_contains: 'invoice' }, msg())).toBe(true);
    expect(matchesGmailTrigger({ from: '*', subject_contains: 'refund' }, msg())).toBe(false);
  });
});

describe('parseGmailTriggerRoutine', () => {
  const record = (dag: unknown) => ({
    id: 'r1',
    name: 'auto-reply',
    is_enabled: true,
    trigger_type: 'gmail_message',
    dag_json: JSON.stringify(dag),
  });

  it('parses a gmail trigger with config', () => {
    const r = parseGmailTriggerRoutine(
      record({
        trigger: {
          triggerType: 'trigger_gmail_message',
          config: { from: '@acme.com', subject_contains: 'urgent' },
        },
        steps: [],
      }),
    );
    expect(r).not.toBeNull();
    expect(r?.trigger).toEqual({ from: '@acme.com', subject_contains: 'urgent' });
  });

  it('defaults from to * and rejects non-gmail triggers', () => {
    const r = parseGmailTriggerRoutine(
      record({ trigger: { triggerType: 'trigger_gmail_message', config: {} }, steps: [] }),
    );
    expect(r?.trigger.from).toBe('*');
    expect(
      parseGmailTriggerRoutine(
        record({ trigger: { triggerType: 'trigger_slack_message', config: {} }, steps: [] }),
      ),
    ).toBeNull();
  });
});

describe('buildGmailTriggerPayload', () => {
  it('exposes the documented {{__trigger__.*}} fields', () => {
    const p = buildGmailTriggerPayload(msg());
    expect(p).toMatchObject({
      from: 'Alice Smith <alice@acme.com>',
      from_address: 'alice@acme.com',
      subject: 'Invoice #42 overdue',
      thread_id: 't1',
      message_id: 'm1',
    });
  });
});
