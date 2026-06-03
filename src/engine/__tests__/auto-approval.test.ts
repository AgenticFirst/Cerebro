/**
 * Tests for the "don't ask again" auto-approval path.
 *
 * Covers:
 *  - runChatAction skips the approval gate (no POST /engine/approvals, no
 *    approval_requested) when a matching rule exists for the exact Slack target.
 *  - runChatAction still gates when no rule matches.
 *  - The action_type→target-param map is the entire bypass surface: a non-mapped
 *    action never resolves a target, so it can never bypass.
 *  - The rule-management methods hit the right backend endpoints.
 *
 * A mock HTTP backend intercepts persistence calls (no real Python backend),
 * mirroring engine-integration.test.ts. runChatAction needs a sharedBus to
 * observe run completion, so the engine is constructed with one.
 */

import http from 'node:http';
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { ExecutionEngine } from '../engine';

// ── Mock backend ────────────────────────────────────────────────

interface CapturedRequest {
  method: string;
  path: string;
  body: any;
}

let mockServer: http.Server;
let serverPort: number;
let captured: CapturedRequest[];

// Dynamic per-test: how many auto-approval rules the GET lookup reports.
let autoApprovalTotal = 0;

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(
          new Error(`Timed out. Captured: ${JSON.stringify(captured.map((r) => `${r.method} ${r.path}`))}`),
        );
      }
      setTimeout(tick, 15);
    };
    tick();
  });
}

function makeMockWebContents() {
  return {
    isDestroyed: () => false,
    send: vi.fn(),
    ipc: { on: vi.fn(), removeListener: vi.fn() },
  } as any;
}

function makeMockRuntime() {
  return { startRun: vi.fn() } as any;
}

/** A Slack channel that reports connected/allowlisted and "sends" successfully. */
function makeMockSlackChannel() {
  return {
    isConnected: () => true,
    isAllowlisted: () => true,
    sendActionMessage: vi.fn(async () => ({ messageTs: '1700000000.000100', error: null })),
  } as any;
}

beforeAll(async () => {
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed: any = null;
      try { parsed = JSON.parse(body); } catch { parsed = body; }
      const url = req.url || '/';
      const method = req.method || 'GET';
      captured.push({ method, path: url, body: parsed });

      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      // Auto-approval lookup / management.
      if (method === 'GET' && url.startsWith('/engine/auto-approvals')) {
        const rules = Array.from({ length: autoApprovalTotal }, (_, i) => ({
          id: `rule${i}`,
          action_type: 'send_slack_message',
          target_key: 'C123',
          target_label: '#general',
          created_at: new Date().toISOString(),
        }));
        return json(200, { rules, total: autoApprovalTotal });
      }
      if (method === 'POST' && url === '/engine/auto-approvals') {
        return json(201, {
          id: 'newrule',
          action_type: parsed?.action_type,
          target_key: parsed?.target_key,
          target_label: parsed?.target_label ?? null,
          created_at: new Date().toISOString(),
        });
      }
      if (method === 'DELETE' && url.startsWith('/engine/auto-approvals')) {
        return json(200, { deleted: 1 });
      }

      // Run / step / event persistence.
      if (method === 'POST' && url === '/engine/runs') {
        return json(201, {
          id: parsed?.id || 'test', status: 'running', run_type: 'chat_action',
          trigger: 'chat', total_steps: parsed?.total_steps || 0, completed_steps: 0,
          started_at: new Date().toISOString(), routine_id: null, expert_id: null,
          conversation_id: null, dag_json: null, error: null, failed_step_id: null,
          completed_at: null, duration_ms: null, steps: null,
        });
      }
      if (method === 'POST' && url.includes('/steps')) {
        const steps = Array.isArray(parsed)
          ? parsed.map((s: any) => ({ ...s, run_id: 'test', summary: null, error: null, started_at: null, completed_at: null, duration_ms: null }))
          : [];
        return json(201, steps);
      }
      if (method === 'POST' && url.includes('/events')) {
        return json(201, { created: parsed?.events?.length || 0 });
      }
      if (method === 'POST' && url === '/engine/approvals') {
        return json(201, { id: parsed?.id, status: 'pending' });
      }
      if (method === 'PATCH') {
        return json(200, { id: 'test', status: parsed?.status || 'running' });
      }
      return json(200, {});
    });
  });

  await new Promise<void>((resolve) => {
    mockServer.listen(0, '127.0.0.1', () => {
      serverPort = (mockServer.address() as any).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
});

beforeEach(() => {
  captured = [];
  autoApprovalTotal = 0;
});

function makeEngine() {
  const engine = new ExecutionEngine(serverPort, makeMockRuntime(), new EventEmitter());
  engine.setSlackChannel(makeMockSlackChannel());
  return engine;
}

// ── runChatAction bypass behavior ───────────────────────────────

describe('runChatAction auto-approval bypass', () => {
  it('skips the approval gate when a matching rule exists', async () => {
    autoApprovalTotal = 1; // rule present for (send_slack_message, C123)
    const engine = makeEngine();

    const result = await engine.runChatAction(makeMockWebContents(), {
      type: 'send_slack_message',
      params: { channel: 'C123', text: 'hello' },
    });

    expect(result.status).toBe('succeeded');

    // It looked up the rule for the exact target...
    const lookup = captured.find(
      (r) => r.method === 'GET' && r.path.startsWith('/engine/auto-approvals'),
    );
    expect(lookup).toBeDefined();
    expect(lookup!.path).toContain('action_type=send_slack_message');
    expect(lookup!.path).toContain('target_key=C123');

    // ...and never created an approval (no gate, no pause).
    const approvalPost = captured.find((r) => r.method === 'POST' && r.path === '/engine/approvals');
    expect(approvalPost).toBeUndefined();
  });

  it('still requires approval when no rule matches', async () => {
    autoApprovalTotal = 0; // no rule
    const engine = makeEngine();

    const runPromise = engine.runChatAction(makeMockWebContents(), {
      type: 'send_slack_message',
      params: { channel: 'C999', text: 'hello' },
    });

    // The gate fires: an approval row is created and the run pauses.
    await waitFor(() => captured.some((r) => r.method === 'POST' && r.path === '/engine/approvals'));
    const approvalPost = captured.find((r) => r.method === 'POST' && r.path === '/engine/approvals');
    expect(approvalPost).toBeDefined();

    // Unblock so the test doesn't hang, then confirm completion.
    await engine.resolveApproval(approvalPost!.body.id, true);
    const result = await runPromise;
    expect(result.status).toBe('succeeded');
  });
});

// ── Bypass surface is exactly the mapped action types ────────────

describe('auto-approval target resolution', () => {
  it('resolves the Slack channel as the target for mapped actions', () => {
    const engine = makeEngine();
    expect(engine.autoApprovalSupported('send_slack_message')).toBe(true);
    expect(engine.autoApprovalSupported('send_slack_file')).toBe(true);
    expect(engine.resolveAutoApprovalTarget('send_slack_message', { channel: 'C123' })).toBe('C123');
    // Missing/empty target → null (always gates).
    expect(engine.resolveAutoApprovalTarget('send_slack_message', {})).toBeNull();
    expect(engine.resolveAutoApprovalTarget('send_slack_message', { channel: '  ' })).toBeNull();
  });

  it('never resolves a target for non-mapped actions (so they can never bypass)', () => {
    const engine = makeEngine();
    expect(engine.autoApprovalSupported('send_notification')).toBe(false);
    expect(engine.autoApprovalSupported('hubspot_create_ticket')).toBe(false);
    expect(engine.resolveAutoApprovalTarget('send_notification', { channel: 'C123' })).toBeNull();
  });
});

// ── Rule-management methods hit the right endpoints ──────────────

describe('auto-approval rule management', () => {
  it('addAutoApprovalRule POSTs the rule', async () => {
    const engine = makeEngine();
    const rule = await engine.addAutoApprovalRule('send_slack_message', 'C123', '#general');
    expect(rule?.target_key).toBe('C123');
    const post = captured.find((r) => r.method === 'POST' && r.path === '/engine/auto-approvals');
    expect(post!.body).toMatchObject({
      action_type: 'send_slack_message',
      target_key: 'C123',
      target_label: '#general',
    });
  });

  it('listAutoApprovalRules GETs the list', async () => {
    autoApprovalTotal = 2;
    const engine = makeEngine();
    const rules = await engine.listAutoApprovalRules();
    expect(rules).toHaveLength(2);
    expect(captured.some((r) => r.method === 'GET' && r.path === '/engine/auto-approvals')).toBe(true);
  });

  it('removeAutoApprovalRulesByTarget DELETEs by exact target', async () => {
    const engine = makeEngine();
    const deleted = await engine.removeAutoApprovalRulesByTarget('send_slack_file', 'C123');
    expect(deleted).toBe(1);
    const del = captured.find((r) => r.method === 'DELETE' && r.path.startsWith('/engine/auto-approvals'));
    expect(del!.path).toContain('action_type=send_slack_file');
    expect(del!.path).toContain('target_key=C123');
  });
});
