/**
 * Smoke tests for the loopback chat-actions HTTP server.
 *
 * The full happy-path (run an action through to completion) is covered by
 * the engine integration tests; here we validate auth, routing, and the
 * catalog endpoint with a stubbed engine so the bridge logic is testable
 * without standing up the whole ExecutionEngine.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { ChatActionServer } from '../server';
import { IPC_CHANNELS } from '../../types/ipc';

interface FetchOptions {
  method?: string;
  path: string;
  token?: string;
  body?: unknown;
  /** Raw request body sent verbatim (bypasses JSON.stringify). Use to exercise malformed payloads. */
  rawBody?: string;
}

async function request(
  port: number,
  opts: FetchOptions,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data =
      opts.rawBody !== undefined ? opts.rawBody : opts.body ? JSON.stringify(opts.body) : '';
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: {
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(data
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data).toString(),
              }
            : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => {
          raw += chunk.toString();
        });
        res.on('end', () => {
          let parsed: unknown = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {
            /* keep raw */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('ChatActionServer', () => {
  let server: ChatActionServer;
  let port: number;
  let token: string;
  let mockEngine: {
    getChatActionCatalog: ReturnType<typeof vi.fn>;
    runChatAction: ReturnType<typeof vi.fn>;
    autoApprovalSupported: ReturnType<typeof vi.fn>;
    addAutoApprovalRule: ReturnType<typeof vi.fn>;
    listAutoApprovalRules: ReturnType<typeof vi.fn>;
    removeAutoApprovalRulesByTarget: ReturnType<typeof vi.fn>;
  };
  let mockSend: ReturnType<typeof vi.fn>;

  let mockEngineDryRun: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockEngineDryRun = vi.fn().mockResolvedValue({
      ok: true,
      runId: 'preview-1',
      steps: [
        {
          stepId: 's1',
          stepName: 'Step 1',
          actionType: 'ask_ai',
          status: 'completed',
          summary: 'ok',
        },
      ],
    });
    mockEngine = {
      getChatActionCatalog: vi.fn().mockReturnValue([
        {
          type: 'send_telegram_message',
          label: 'Send Telegram message',
          description: 'Send a Telegram message…',
          examples: ['Send Pablo a Telegram'],
          availability: 'available',
          group: 'telegram',
          inputSchema: { type: 'object' },
        },
      ]),
      runChatAction: vi.fn().mockResolvedValue({
        status: 'succeeded',
        runId: 'r1',
        approvalId: 'a1',
        summary: 'done',
        data: { sent: true },
      }),
      dryRunRoutine: mockEngineDryRun,
      autoApprovalSupported: vi.fn(
        (t: string) => t === 'send_slack_message' || t === 'send_slack_file',
      ),
      addAutoApprovalRule: vi.fn(
        async (action_type: string, target_key: string, target_label?: string) => ({
          id: 'rule1',
          action_type,
          target_key,
          target_label: target_label ?? null,
          created_at: '2026-01-01T00:00:00Z',
        }),
      ),
      listAutoApprovalRules: vi.fn(async () => [
        {
          id: 'rule1',
          action_type: 'send_slack_message',
          target_key: 'C123',
          target_label: '#general',
          created_at: '2026-01-01T00:00:00Z',
        },
      ]),
      removeAutoApprovalRulesByTarget: vi.fn(async () => 2),
    };
    mockSend = vi.fn();
    server = new ChatActionServer({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      engine: mockEngine as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getMainWebContents: () => ({ isDestroyed: () => false, send: mockSend }) as any,
    });
    const info = await server.start();
    port = info.port;
    token = info.token;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(port, { path: '/chat-actions/health' });
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await request(port, { path: '/nope', token });
    expect(res.status).toBe(404);
  });

  it('serves the catalog for the requested language', async () => {
    const res = await request(port, { path: '/chat-actions/catalog?lang=es', token });
    expect(res.status).toBe(200);
    expect(mockEngine.getChatActionCatalog).toHaveBeenCalledWith('es');
    const body = res.body as { lang: string; actions: Array<{ type: string }> };
    expect(body.lang).toBe('es');
    expect(body.actions[0].type).toBe('send_telegram_message');
  });

  it('defaults to English when lang is missing', async () => {
    await request(port, { path: '/chat-actions/catalog', token });
    expect(mockEngine.getChatActionCatalog).toHaveBeenCalledWith('en');
  });

  it('runs a chat action when the body is valid', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/chat-actions/run',
      token,
      body: { type: 'send_telegram_message', params: { chat_id: '1', message: 'hi' } },
    });
    expect(res.status).toBe(200);
    expect(mockEngine.runChatAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'send_telegram_message' }),
    );
    const body = res.body as { status: string; data?: Record<string, unknown> };
    expect(body.status).toBe('succeeded');
    expect(body.data?.sent).toBe(true);
  });

  it('forwards conversation_id from the body so the approval surfaces inline in chat', async () => {
    // The chat subprocess (run-chat-action.sh) stamps the originating
    // conversation onto the body. The server must pass it through to
    // runChatAction → startRun, otherwise the run record is saved with a null
    // conversation and the inline approval card never renders.
    const res = await request(port, {
      method: 'POST',
      path: '/chat-actions/run',
      token,
      body: {
        type: 'hubspot_create_ticket',
        params: { subject: 'x' },
        conversation_id: 'conv-xyz',
      },
    });
    expect(res.status).toBe(200);
    expect(mockEngine.runChatAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'hubspot_create_ticket', conversationId: 'conv-xyz' }),
    );
  });

  it('passes conversationId=undefined when the body omits conversation_id (desktop chat)', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/chat-actions/run',
      token,
      body: { type: 'send_telegram_message', params: { chat_id: '1', message: 'hi' } },
    });
    expect(res.status).toBe(200);
    const call = mockEngine.runChatAction.mock.calls.at(-1)!;
    expect((call[1] as { conversationId?: string }).conversationId).toBeUndefined();
  });

  it('rejects /run with a malformed JSON body with 400, not 500', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/chat-actions/run',
      token,
      rawBody: '{ "type": "send_telegram_message", ', // truncated → invalid JSON
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('invalid_json');
    expect(mockEngine.runChatAction).not.toHaveBeenCalled();
  });

  it('rejects /run with no type', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/chat-actions/run',
      token,
      body: { params: {} },
    });
    expect(res.status).toBe(400);
  });

  it('returns 403 when an action is denied', async () => {
    mockEngine.runChatAction.mockResolvedValueOnce({
      status: 'denied',
      runId: 'r2',
      approvalId: 'a2',
      error: 'denied by user',
    });
    const res = await request(port, {
      method: 'POST',
      path: '/chat-actions/run',
      token,
      body: { type: 'send_telegram_message', params: {} },
    });
    expect(res.status).toBe(403);
    expect((res.body as { status: string }).status).toBe('denied');
  });

  it('returns 409 when the integration is not connected', async () => {
    mockEngine.runChatAction.mockResolvedValueOnce({
      status: 'unavailable',
      error: 'HubSpot is not connected',
    });
    const res = await request(port, {
      method: 'POST',
      path: '/chat-actions/run',
      token,
      body: { type: 'hubspot_create_ticket', params: { subject: 'x' } },
    });
    expect(res.status).toBe(409);
  });

  it('rejects dry-run-routine without a dag', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/chat-actions/dry-run-routine',
      token,
      body: {},
    });
    expect(res.status).toBe(400);
  });

  it('forwards dry-run-routine to the engine and returns its result', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/chat-actions/dry-run-routine',
      token,
      body: {
        dag: {
          steps: [
            {
              id: 's1',
              name: 'Step 1',
              actionType: 'ask_ai',
              params: {},
              dependsOn: [],
              inputMappings: [],
              requiresApproval: false,
              onError: 'fail',
            },
          ],
        },
      },
    });
    expect(res.status).toBe(200);
    expect(mockEngineDryRun).toHaveBeenCalled();
    const body = res.body as { ok: boolean; steps: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.steps).toHaveLength(1);
  });

  it('emits an integration setup proposal event when given a known id', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/chat-actions/propose-integration',
      token,
      body: { integration_id: 'telegram', reason: 'so you can DM Pablo' },
    });
    expect(res.status).toBe(200);
    expect(mockSend).toHaveBeenCalledWith(
      IPC_CHANNELS.INTEGRATION_PROPOSAL,
      expect.objectContaining({
        integrationId: 'telegram',
        reason: 'so you can DM Pablo',
      }),
    );
    const body = res.body as { ok: boolean; integration_id: string };
    expect(body.ok).toBe(true);
    expect(body.integration_id).toBe('telegram');
  });

  it('rejects propose-integration with an unknown integration id', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/chat-actions/propose-integration',
      token,
      body: { integration_id: 'salesforce' },
    });
    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects propose-integration without an integration_id', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/chat-actions/propose-integration',
      token,
      body: { reason: 'just because' },
    });
    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('emits a team-run-announced event when given a valid payload', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/chat-actions/announce-team-run',
      token,
      body: {
        team_id: 'fitness-team-abc',
        team_name: 'Fitness Team',
        strategy: 'sequential',
        members: [
          { member_id: 'coach', member_name: 'Running Coach', role: 'coach' },
          { member_id: 'nutri', member_name: 'Nutritionist', role: 'nutritionist' },
        ],
        conversation_id: 'conv-1',
      },
    });
    expect(res.status).toBe(200);
    expect(mockSend).toHaveBeenCalledWith(
      IPC_CHANNELS.TEAM_RUN_ANNOUNCED,
      expect.objectContaining({
        teamId: 'fitness-team-abc',
        teamName: 'Fitness Team',
        strategy: 'sequential',
        conversationId: 'conv-1',
        members: [
          { memberId: 'coach', memberName: 'Running Coach', role: 'coach' },
          { memberId: 'nutri', memberName: 'Nutritionist', role: 'nutritionist' },
        ],
      }),
    );
  });

  it('rejects announce-team-run with empty members array', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/chat-actions/announce-team-run',
      token,
      body: { team_id: 't', team_name: 'T', strategy: 'sequential', members: [] },
    });
    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects announce-team-run with malformed member entries', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/chat-actions/announce-team-run',
      token,
      body: {
        team_id: 't',
        team_name: 'T',
        strategy: 'sequential',
        members: [{ member_id: 'a' /* missing member_name */ }],
      },
    });
    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('emits a team-member-update event for valid statuses', async () => {
    for (const status of ['running', 'completed', 'error'] as const) {
      mockSend.mockClear();
      const res = await request(port, {
        method: 'POST',
        path: '/chat-actions/team-member-update',
        token,
        body: {
          team_id: 't',
          member_id: 'm',
          status,
          ...(status === 'error' ? { error_message: 'boom' } : {}),
        },
      });
      expect(res.status).toBe(200);
      expect(mockSend).toHaveBeenCalledWith(
        IPC_CHANNELS.TEAM_MEMBER_UPDATE,
        expect.objectContaining({
          teamId: 't',
          memberId: 'm',
          status,
          ...(status === 'error' ? { errorMessage: 'boom' } : {}),
        }),
      );
    }
  });

  it('rejects team-member-update with an invalid status', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/chat-actions/team-member-update',
      token,
      body: { team_id: 't', member_id: 'm', status: 'wat' },
    });
    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns ok=false (still 200) when dry-run reports a step failure', async () => {
    mockEngineDryRun.mockResolvedValueOnce({
      ok: false,
      runId: 'preview-2',
      error: 'something broke',
      failedStepId: 's1',
      steps: [
        {
          stepId: 's1',
          stepName: 'Step 1',
          actionType: 'ask_ai',
          status: 'failed',
          error: 'something broke',
        },
      ],
    });
    const res = await request(port, {
      method: 'POST',
      path: '/chat-actions/dry-run-routine',
      token,
      body: {
        dag: {
          steps: [
            {
              id: 's1',
              name: 'Step 1',
              actionType: 'ask_ai',
              params: {},
              dependsOn: [],
              inputMappings: [],
              requiresApproval: false,
              onError: 'fail',
            },
          ],
        },
      },
    });
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; failedStepId?: string };
    expect(body.ok).toBe(false);
    expect(body.failedStepId).toBe('s1');
  });

  // ── Auto-approval rules ──────────────────────────────────────

  it('creates an auto-approval rule for an eligible action', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/chat-actions/auto-approvals',
      token,
      body: { action_type: 'send_slack_message', target_key: 'C123', target_label: '#general' },
    });
    expect(res.status).toBe(200);
    expect(mockEngine.addAutoApprovalRule).toHaveBeenCalledWith(
      'send_slack_message',
      'C123',
      '#general',
    );
    const body = res.body as { ok: boolean; rule: { target_key: string } };
    expect(body.ok).toBe(true);
    expect(body.rule.target_key).toBe('C123');
  });

  it('rejects an auto-approval rule for an ineligible action', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/chat-actions/auto-approvals',
      token,
      body: { action_type: 'hubspot_create_ticket', target_key: 'X' },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain('not_auto_approvable');
    expect(mockEngine.addAutoApprovalRule).not.toHaveBeenCalled();
  });

  it('rejects an auto-approval rule with no target_key', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/chat-actions/auto-approvals',
      token,
      body: { action_type: 'send_slack_message' },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('missing_target_key');
  });

  it('lists auto-approval rules', async () => {
    const res = await request(port, { path: '/chat-actions/auto-approvals', token });
    expect(res.status).toBe(200);
    expect(mockEngine.listAutoApprovalRules).toHaveBeenCalled();
    const body = res.body as { rules: Array<{ target_key: string }> };
    expect(body.rules[0].target_key).toBe('C123');
  });

  it('revokes auto-approval rules by target', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/chat-actions/auto-approvals/revoke',
      token,
      body: { action_type: 'send_slack_message', target_key: 'C123' },
    });
    expect(res.status).toBe(200);
    expect(mockEngine.removeAutoApprovalRulesByTarget).toHaveBeenCalledWith(
      'send_slack_message',
      'C123',
    );
    expect((res.body as { deleted: number }).deleted).toBe(2);
  });

  it('requires auth for auto-approval endpoints', async () => {
    const res = await request(port, { path: '/chat-actions/auto-approvals' });
    expect(res.status).toBe(401);
  });
});
