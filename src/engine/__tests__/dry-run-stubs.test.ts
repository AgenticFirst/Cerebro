/**
 * Tests for the dry-run stub registry. Validates that side-effecty actions
 * are replaced with synthetic-success stubs that match the real action's
 * output shape, while pure control-flow actions (condition, loop, etc.)
 * pass through unchanged.
 */

import { describe, it, expect, vi } from 'vitest';
import { wrapForDryRun } from '../dry-run-stubs';
import type { ActionDefinition, ActionInput } from '../actions/types';

function makeFakeAction(type: string): ActionDefinition {
  return {
    type,
    name: type,
    description: '',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    execute: vi.fn().mockResolvedValue({ data: { real: true }, summary: 'real run' }),
  };
}

function makeInput(params: Record<string, unknown> = {}): ActionInput {
  const logs: string[] = [];
  return {
    params,
    wiredInputs: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scratchpad: {} as any,
    context: {
      runId: 'test',
      stepId: 'test-step',
      backendPort: 0,
      signal: new AbortController().signal,
      log: (m) => logs.push(m),
      emitEvent: () => {/* noop */},
    },
  };
}

describe('wrapForDryRun', () => {
  it('replaces hubspot_create_ticket execute with a synthetic success', async () => {
    const real = makeFakeAction('hubspot_create_ticket');
    const wrapped = wrapForDryRun(real);

    const out = await wrapped.execute(makeInput({ subject: 'Test' }));
    expect(out.data.created).toBe(true);
    expect(out.data.ticket_id).toMatch(/^dryrun-/);
    // The real execute must NOT have been called.
    expect(real.execute).not.toHaveBeenCalled();
  });

  it('stubs send_telegram_message and echoes the chat_id from params', async () => {
    const real = makeFakeAction('send_telegram_message');
    const wrapped = wrapForDryRun(real);
    const out = await wrapped.execute(makeInput({ chat_id: '123', message: 'hi' }));
    expect(out.data.sent).toBe(true);
    expect(out.data.chat_id).toBe('123');
    expect(real.execute).not.toHaveBeenCalled();
  });

  it('stubs http_request with a 200 success body so condition steps stay on the happy path', async () => {
    const real = makeFakeAction('http_request');
    const wrapped = wrapForDryRun(real);
    const out = await wrapped.execute(makeInput({ method: 'POST', url: 'https://example.com' }));
    expect(out.data.status).toBe(200);
    expect(out.summary).toContain('POST');
    expect(out.summary).toContain('https://example.com');
  });

  it('stubs ask_ai with a populated response so downstream wiring still resolves', async () => {
    const real = makeFakeAction('ask_ai');
    const wrapped = wrapForDryRun(real);
    const out = await wrapped.execute(makeInput({ prompt: 'hi' }));
    expect(typeof out.data.response).toBe('string');
    expect((out.data.response as string).length).toBeGreaterThan(0);
  });

  it('passes through control-flow actions (condition, loop, transformer) unchanged', () => {
    // delay and approval_gate are stubbed so the dry-run finishes quickly /
    // doesn't block on a human; the remaining control-flow actions still run
    // for real because they're cheap and their actual logic is what we're
    // trying to verify.
    for (const type of ['condition', 'loop', 'transformer']) {
      const real = makeFakeAction(type);
      const wrapped = wrapForDryRun(real);
      expect(wrapped).toBe(real);
    }
  });

  it('logs that side-effects were skipped so the dry-run trace is auditable', async () => {
    const real = makeFakeAction('send_whatsapp_message');
    const wrapped = wrapForDryRun(real);
    const logs: string[] = [];
    const input = makeInput({ phone_number: '+1', message: 'hi' });
    input.context.log = (m) => logs.push(m);

    await wrapped.execute(input);
    expect(logs.some((m) => m.includes('[dry-run]'))).toBe(true);
  });
});
