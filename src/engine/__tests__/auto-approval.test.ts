/**
 * Tests for the "don't ask again" auto-approval path.
 *
 * Covers:
 *  - runChatAction skips the approval gate (no POST /engine/approvals) when a
 *    matching rule exists at any scope: exact destination, whole action type
 *    (target '*'), or whole integration module (`module:<group>` / '*').
 *  - runChatAction still gates when no rule matches at any scope.
 *  - autoApprovalSupported accepts write actions + module tokens and rejects
 *    read-only actions / unknown types; resolveAutoApprovalTarget reads the
 *    right destination param per integration.
 *  - The rule-management methods hit the right backend endpoints.
 *
 * A mock HTTP backend intercepts persistence calls (no real Python backend),
 * mirroring engine-integration.test.ts. runChatAction needs a sharedBus to
 * observe run completion, so the engine is constructed with one.
 */

import http from 'node:http';
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { ExecutionEngine, AUTO_APPROVAL_TARGET_PARAM } from '../engine';
import type { ActionDefinition } from '../actions/types';
import { findContact } from '../../hubspot/contacts';

// hubspot_search_contact calls findContact() against the live HubSpot API. Mock
// it so the read-only bulk-lookup test runs fully offline and deterministically.
vi.mock('../../hubspot/contacts', () => ({
  findContact: vi.fn(async (_token: string, _property: string, value: string) => ({
    contact: {
      id: `contact_${value}`,
      properties: { email: value, firstname: 'Test', lastname: 'User' },
    },
    error: null,
  })),
}));

// ── Mock backend ────────────────────────────────────────────────

interface CapturedRequest {
  method: string;
  path: string;
  body: any;
}

let mockServer: http.Server;
let serverPort: number;
let captured: CapturedRequest[];

// Dynamic per-test: the auto-approval rules the mock backend holds. The GET
// handler filters by action_type/target_key when present (mirroring router.py),
// so tests can exercise destination-, action-, and module-scoped matching.
interface MockRule {
  action_type: string;
  target_key: string;
  target_label?: string | null;
}
let mockRules: MockRule[] = [];

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(
          new Error(
            `Timed out. Captured: ${JSON.stringify(captured.map((r) => `${r.method} ${r.path}`))}`,
          ),
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
    listChannels: vi.fn(async () => ({
      ok: true,
      channels: [{ id: 'C123', name: 'general', is_private: false }],
      error: null,
    })),
  } as any;
}

beforeAll(async () => {
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      let parsed: any = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = body;
      }
      const url = req.url || '/';
      const method = req.method || 'GET';
      captured.push({ method, path: url, body: parsed });

      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      // Auto-approval lookup / management. Filters by action_type/target_key
      // exactly like the real backend, so scoped-rule matching is faithful.
      if (method === 'GET' && url.startsWith('/engine/auto-approvals')) {
        const params = new URL(url, 'http://x').searchParams;
        const at = params.get('action_type');
        const tk = params.get('target_key');
        let matched = mockRules;
        if (at) matched = matched.filter((r) => r.action_type === at);
        if (tk) matched = matched.filter((r) => r.target_key === tk);
        const rules = matched.map((r, i) => ({
          id: `rule${i}`,
          action_type: r.action_type,
          target_key: r.target_key,
          target_label: r.target_label ?? null,
          created_at: new Date().toISOString(),
        }));
        return json(200, { rules, total: rules.length });
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
          id: parsed?.id || 'test',
          status: 'running',
          run_type: 'chat_action',
          trigger: 'chat',
          total_steps: parsed?.total_steps || 0,
          completed_steps: 0,
          started_at: new Date().toISOString(),
          routine_id: null,
          expert_id: null,
          conversation_id: null,
          dag_json: null,
          error: null,
          failed_step_id: null,
          completed_at: null,
          duration_ms: null,
          steps: null,
        });
      }
      if (method === 'POST' && url.includes('/steps')) {
        const steps = Array.isArray(parsed)
          ? parsed.map((s: any) => ({
              ...s,
              run_id: 'test',
              summary: null,
              error: null,
              started_at: null,
              completed_at: null,
              duration_ms: null,
            }))
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

/** A connected HubSpot channel; only getAccessToken + isConnected are exercised. */
function makeMockHubSpotChannel() {
  return {
    getAccessToken: () => 'test-token',
    isConnected: () => true,
    getDefaultPipeline: () => 'p1',
    getDefaultStage: () => 's1',
    getFollowUpProperty: () => null,
    getDueDateProperty: () => null,
    getPortalId: () => '12345',
    listPipelines: vi.fn(async () => ({ ok: true, pipelines: [] })),
  } as any;
}

beforeEach(() => {
  captured = [];
  mockRules = [];
  (findContact as any).mockClear();
});

function makeEngine() {
  const engine = new ExecutionEngine(serverPort, makeMockRuntime(), new EventEmitter());
  engine.setSlackChannel(makeMockSlackChannel());
  return engine;
}

// ── runChatAction bypass behavior ───────────────────────────────

describe('runChatAction auto-approval bypass', () => {
  it('skips the approval gate when a matching destination rule exists', async () => {
    // Rule present for the exact destination (send_slack_message, C123).
    mockRules = [
      { action_type: 'send_slack_message', target_key: 'C123', target_label: '#general' },
    ];
    const engine = makeEngine();

    const result = await engine.runChatAction(makeMockWebContents(), {
      type: 'send_slack_message',
      params: { channel: 'C123', text: 'hello' },
    });

    expect(result.status).toBe('succeeded');

    // It looked up the rule for the exact target first (most-specific), and
    // short-circuited there — exactly one auto-approval lookup, no module check.
    const lookups = captured.filter(
      (r) => r.method === 'GET' && r.path.startsWith('/engine/auto-approvals'),
    );
    expect(lookups).toHaveLength(1);
    expect(lookups[0].path).toContain('action_type=send_slack_message');
    expect(lookups[0].path).toContain('target_key=C123');

    // ...and never created an approval (no gate, no pause).
    const approvalPost = captured.find(
      (r) => r.method === 'POST' && r.path === '/engine/approvals',
    );
    expect(approvalPost).toBeUndefined();
  });

  it('skips the gate for a per-action rule (any destination)', async () => {
    // "Don't ask before any Slack message" — target '*', no destination rule.
    mockRules = [{ action_type: 'send_slack_message', target_key: '*' }];
    const engine = makeEngine();

    const result = await engine.runChatAction(makeMockWebContents(), {
      type: 'send_slack_message',
      params: { channel: 'C999', text: 'hello' },
    });

    expect(result.status).toBe('succeeded');
    expect(
      captured.find((r) => r.method === 'POST' && r.path === '/engine/approvals'),
    ).toBeUndefined();
  });

  it('skips the gate for a per-module rule (whole integration)', async () => {
    // "Don't ask for Slack at all" — module:slack / '*'. The matching logic is
    // integration-agnostic, so testing it via Slack (clean mock) also proves the
    // reported HubSpot case (module:hubspot would match the same way).
    mockRules = [{ action_type: 'module:slack', target_key: '*' }];
    const engine = makeEngine();

    const result = await engine.runChatAction(makeMockWebContents(), {
      type: 'send_slack_message',
      params: { channel: 'C999', text: 'hello' },
    });

    expect(result.status).toBe('succeeded');
    expect(
      captured.find((r) => r.method === 'POST' && r.path === '/engine/approvals'),
    ).toBeUndefined();
    // The module-scoped lookup was consulted.
    expect(
      captured.some(
        (r) =>
          r.method === 'GET' &&
          r.path.includes('action_type=module%3Aslack') &&
          r.path.includes('target_key=*'),
      ),
    ).toBe(true);
  });

  it('still requires approval when no rule matches', async () => {
    mockRules = []; // no rule at any scope
    const engine = makeEngine();

    const runPromise = engine.runChatAction(makeMockWebContents(), {
      type: 'send_slack_message',
      params: { channel: 'C999', text: 'hello' },
    });

    // The gate fires: an approval row is created and the run pauses.
    await waitFor(() =>
      captured.some((r) => r.method === 'POST' && r.path === '/engine/approvals'),
    );
    const approvalPost = captured.find(
      (r) => r.method === 'POST' && r.path === '/engine/approvals',
    );
    expect(approvalPost).toBeDefined();

    // Unblock so the test doesn't hang, then confirm completion.
    await engine.resolveApproval(approvalPost!.body.id, true);
    const result = await runPromise;
    expect(result.status).toBe('succeeded');
  });
});

// ── Read-only actions skip the gate entirely ────────────────────

describe('runChatAction read-only bypass', () => {
  it('runs a read-only action without gating or even checking auto-approval rules', async () => {
    mockRules = []; // no rule — a write would gate here
    const engine = makeEngine();

    const result = await engine.runChatAction(makeMockWebContents(), {
      type: 'list_slack_channels',
      params: {},
    });

    expect(result.status).toBe('succeeded');

    // No approval was ever created — read-only means no pause.
    const approvalPost = captured.find(
      (r) => r.method === 'POST' && r.path === '/engine/approvals',
    );
    expect(approvalPost).toBeUndefined();

    // The read-only branch short-circuits before the rule lookup, so we never
    // even query /engine/auto-approvals for it.
    const lookup = captured.find(
      (r) => r.method === 'GET' && r.path.startsWith('/engine/auto-approvals'),
    );
    expect(lookup).toBeUndefined();
  });

  it('still gates a write action with no matching rule (regression guard)', async () => {
    mockRules = [];
    const engine = makeEngine();

    const runPromise = engine.runChatAction(makeMockWebContents(), {
      type: 'send_slack_message',
      params: { channel: 'C999', text: 'hello' },
    });

    await waitFor(() =>
      captured.some((r) => r.method === 'POST' && r.path === '/engine/approvals'),
    );
    const approvalPost = captured.find(
      (r) => r.method === 'POST' && r.path === '/engine/approvals',
    );
    expect(approvalPost).toBeDefined();

    await engine.resolveApproval(approvalPost!.body.id, true);
    const result = await runPromise;
    expect(result.status).toBe('succeeded');
  });
});

// ── Regression: the exact reported bug ──────────────────────────
// "Reviewing 20 HubSpot contacts asked for approval one-by-one." A HubSpot
// contact lookup is read-only, so each call must run immediately with no gate.

describe('regression: bulk HubSpot contact reads never request approval', () => {
  it('looks up 20 contacts via runChatAction with zero approval requests', async () => {
    mockRules = []; // no auto-approval rules exist
    const engine = makeEngine();
    engine.setHubSpotChannel(makeMockHubSpotChannel());

    const emails = Array.from({ length: 20 }, (_, i) => `person${i}@example.com`);
    const results = [];
    for (const email of emails) {
      results.push(
        await engine.runChatAction(makeMockWebContents(), {
          type: 'hubspot_search_contact',
          params: { email },
        }),
      );
    }

    // Every lookup succeeded...
    expect(results).toHaveLength(20);
    expect(results.every((r) => r.status === 'succeeded')).toBe(true);
    expect((findContact as any).mock.calls).toHaveLength(20);

    // ...and not a single approval was created across all 20.
    const approvals = captured.filter((r) => r.method === 'POST' && r.path === '/engine/approvals');
    expect(approvals).toHaveLength(0);

    // Read-only short-circuits before the rule lookup too — no auto-approval GETs.
    const ruleLookups = captured.filter(
      (r) => r.method === 'GET' && r.path.startsWith('/engine/auto-approvals'),
    );
    expect(ruleLookups).toHaveLength(0);
  });
});

// ── Eligibility: which actions/modules can have a rule at all ─────

describe('autoApprovalSupported', () => {
  it('accepts write actions (any integration) and module tokens', () => {
    const engine = makeEngine();
    expect(engine.autoApprovalSupported('send_slack_message')).toBe(true);
    expect(engine.autoApprovalSupported('send_slack_file')).toBe(true);
    expect(engine.autoApprovalSupported('send_telegram_message')).toBe(true);
    expect(engine.autoApprovalSupported('send_whatsapp_message')).toBe(true);
    // The reported case: HubSpot writes are now eligible (no longer "Slack only").
    expect(engine.autoApprovalSupported('hubspot_create_ticket')).toBe(true);
    expect(engine.autoApprovalSupported('module:hubspot')).toBe(true);
    expect(engine.autoApprovalSupported('module:slack')).toBe(true);
  });

  it('rejects read-only actions, unknown types, and empty modules', () => {
    const engine = makeEngine();
    // Read-only actions never gate, so a rule would be meaningless.
    expect(engine.autoApprovalSupported('hubspot_search_contact')).toBe(false);
    expect(engine.autoApprovalSupported('list_slack_channels')).toBe(false);
    // Unknown action type / module with no writable action → rejected.
    expect(engine.autoApprovalSupported('definitely_not_an_action')).toBe(false);
    expect(engine.autoApprovalSupported('module:nope')).toBe(false);
  });
});

describe('resolveAutoApprovalTarget', () => {
  it('resolves the destination param for messaging sends', () => {
    const engine = makeEngine();
    expect(engine.resolveAutoApprovalTarget('send_slack_message', { channel: 'C123' })).toBe(
      'C123',
    );
    expect(engine.resolveAutoApprovalTarget('send_telegram_message', { chat_id: '99' })).toBe('99');
    expect(
      engine.resolveAutoApprovalTarget('send_whatsapp_message', { phone_number: '+14155552671' }),
    ).toBe('+14155552671');
    // Missing/empty target → null.
    expect(engine.resolveAutoApprovalTarget('send_slack_message', {})).toBeNull();
    expect(engine.resolveAutoApprovalTarget('send_slack_message', { channel: '  ' })).toBeNull();
  });

  it('returns null for actions with no single destination param (they use action/module scope)', () => {
    const engine = makeEngine();
    expect(engine.resolveAutoApprovalTarget('hubspot_create_ticket', { subject: 'x' })).toBeNull();
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
    mockRules = [
      { action_type: 'send_slack_message', target_key: 'C123' },
      { action_type: 'module:hubspot', target_key: '*' },
    ];
    const engine = makeEngine();
    const rules = await engine.listAutoApprovalRules();
    expect(rules).toHaveLength(2);
    expect(captured.some((r) => r.method === 'GET' && r.path === '/engine/auto-approvals')).toBe(
      true,
    );
  });

  it('removeAutoApprovalRulesByTarget DELETEs by exact target', async () => {
    const engine = makeEngine();
    const deleted = await engine.removeAutoApprovalRulesByTarget('send_slack_file', 'C123');
    expect(deleted).toBe(1);
    const del = captured.find(
      (r) => r.method === 'DELETE' && r.path.startsWith('/engine/auto-approvals'),
    );
    expect(del!.path).toContain('action_type=send_slack_file');
    expect(del!.path).toContain('target_key=C123');
  });
});

// ── Production invariants over the live action catalog ───────────
//
// These don't test a scenario — they assert the structural guarantees the fix
// depends on, against the REAL action registry. They fail the build the moment
// someone adds a write action without a `chatGroup`, mis-maps a destination
// param, or leaves a dead entry in AUTO_APPROVAL_TARGET_PARAM — i.e. the exact
// regressions that would silently let "don't ask for <X>" stop covering part of
// an integration in production.

/** The exact action defs runChatAction gates against. */
function chatExposableDefs(engine: ExecutionEngine): ActionDefinition[] {
  return (engine as any).buildChatExposableDefs() as ActionDefinition[];
}

describe('catalog invariant: every write is coverable by action AND module scope', () => {
  it('each chat-exposable write action has a chatGroup and is auto-approvable at both scopes', () => {
    const engine = makeEngine();
    const writes = chatExposableDefs(engine).filter((d) => !d.readOnly);

    // Sanity: the catalog actually contains writes (guards a broken mock/registry).
    expect(writes.length).toBeGreaterThan(10);

    for (const def of writes) {
      // A non-empty chatGroup is what a `module:<group>` rule keys off. Without
      // it, "don't ask for this integration" could never cover this action.
      expect(def.chatGroup, `write action '${def.type}' is missing chatGroup`).toBeTruthy();

      // Per-action scope: the user can always silence this one action type.
      expect(
        engine.autoApprovalSupported(def.type),
        `write action '${def.type}' should be auto-approvable by action type`,
      ).toBe(true);

      // Per-module scope: the user can silence the whole integration.
      expect(
        engine.autoApprovalSupported(`module:${def.chatGroup}`),
        `module:${def.chatGroup} should be auto-approvable (covers '${def.type}')`,
      ).toBe(true);
    }
  });

  it('the reported integrations all expose at least one auto-approvable write', () => {
    const engine = makeEngine();
    const groups = new Set(
      chatExposableDefs(engine)
        .filter((d) => !d.readOnly && d.chatGroup)
        .map((d) => d.chatGroup as string),
    );
    // HubSpot is the integration from the bug report; the others were in scope.
    for (const g of ['hubspot', 'slack', 'telegram', 'whatsapp', 'github', 'calendar']) {
      expect(groups.has(g), `expected writable integration '${g}' in the catalog`).toBe(true);
      expect(engine.autoApprovalSupported(`module:${g}`)).toBe(true);
    }
  });
});

describe('catalog invariant: read-only actions can never carry a rule', () => {
  it('every read-only chat action is rejected by autoApprovalSupported', () => {
    const engine = makeEngine();
    const reads = chatExposableDefs(engine).filter((d) => d.readOnly);
    expect(reads.length).toBeGreaterThan(0);
    for (const def of reads) {
      expect(
        engine.autoApprovalSupported(def.type),
        `read-only action '${def.type}' must not be auto-approvable (it never gates)`,
      ).toBe(false);
    }
  });
});

describe('catalog invariant: AUTO_APPROVAL_TARGET_PARAM has no drift', () => {
  it('every mapped action exists, is a write, and actually has that destination param', () => {
    const engine = makeEngine();
    const byType = new Map(chatExposableDefs(engine).map((d) => [d.type, d]));

    for (const [actionType, paramName] of Object.entries(AUTO_APPROVAL_TARGET_PARAM)) {
      const def = byType.get(actionType);
      // No dead/typo'd entries — every mapped action is a real chat action.
      expect(
        def,
        `AUTO_APPROVAL_TARGET_PARAM entry '${actionType}' is not a chat action`,
      ).toBeDefined();
      // Read-only actions never gate, so mapping a destination for them is a bug.
      expect(def!.readOnly, `mapped action '${actionType}' must be a write`).toBeFalsy();
      // The mapped param must exist in the action's input schema, or a
      // destination-scoped rule would silently never match.
      const props = (def!.inputSchema as any)?.properties ?? {};
      expect(
        Object.prototype.hasOwnProperty.call(props, paramName),
        `'${actionType}' has no input param '${paramName}' (destination map drift)`,
      ).toBe(true);
    }
  });
});

// ── The reported bug, decided against the REAL HubSpot write def ─────
//
// Proves the gate decision for an actual HubSpot write — without executing it —
// so we cover the exact "don't ask for HubSpot" path end-to-end at the engine's
// decision boundary (isAutoApproved is what runChatAction branches on).

describe('regression: a real HubSpot write is bypassed by a module/action rule', () => {
  function hubspotWriteDef(engine: ExecutionEngine): ActionDefinition {
    const def = chatExposableDefs(engine).find((d) => d.type === 'hubspot_create_ticket');
    if (!def) throw new Error('hubspot_create_ticket not found in catalog');
    return def;
  }

  it('gates by default (no rule)', async () => {
    mockRules = [];
    const engine = makeEngine();
    const approved = await (engine as any).isAutoApproved(hubspotWriteDef(engine), {
      subject: 'Help',
    });
    expect(approved).toBe(false);
  });

  it('is bypassed by a per-module rule (module:hubspot / *)', async () => {
    mockRules = [{ action_type: 'module:hubspot', target_key: '*' }];
    const engine = makeEngine();
    const approved = await (engine as any).isAutoApproved(hubspotWriteDef(engine), {
      subject: 'Help',
    });
    expect(approved).toBe(true);
  });

  it('is bypassed by a per-action rule (hubspot_create_ticket / *)', async () => {
    mockRules = [{ action_type: 'hubspot_create_ticket', target_key: '*' }];
    const engine = makeEngine();
    const approved = await (engine as any).isAutoApproved(hubspotWriteDef(engine), {
      subject: 'Help',
    });
    expect(approved).toBe(true);
  });

  it('is NOT bypassed by an unrelated module rule (module:slack)', async () => {
    mockRules = [{ action_type: 'module:slack', target_key: '*' }];
    const engine = makeEngine();
    const approved = await (engine as any).isAutoApproved(hubspotWriteDef(engine), {
      subject: 'Help',
    });
    expect(approved).toBe(false);
  });
});
