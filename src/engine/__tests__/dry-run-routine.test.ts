/**
 * End-to-end tests for ExecutionEngine.dryRunRoutine — the public surface
 * the chat skill calls before persisting a Cerebro-proposed routine.
 *
 * These tests do NOT call any LLM. They feed hand-crafted DAGs through the
 * real engine + dry-run stubs and assert:
 *   - Pure-success DAGs return ok=true with every step completed
 *   - Required-field violations (including templates that point at fields
 *     the upstream step never produces) surface as a step failure
 *   - Approval gates auto-pass in dry-run (so the test isn't blocked)
 *   - Branch/condition logic is still exercised — control-flow actions
 *     pass through unwrapped
 *   - HubSpot / Telegram / WhatsApp work without configured channels —
 *     stubs replace execute, so dry-run is portable across environments
 *
 * The mock HTTP server pretends to be the Python backend so engine
 * persistence calls don't blow up. It mirrors the pattern used by
 * src/engine/__tests__/engine-integration.test.ts.
 */

import http from 'node:http';
import EventEmitter from 'node:events';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ExecutionEngine } from '../engine';
import type { DAGDefinition, StepDefinition } from '../dag/types';

// ── Mock backend ────────────────────────────────────────────────

let mockServer: http.Server;
let serverPort: number;

beforeAll(async () => {
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed: unknown = null;
      try { parsed = body ? JSON.parse(body) : null; } catch { parsed = body; }

      const url = req.url ?? '';
      if (req.method === 'POST' && url.endsWith('/runs')) {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: (parsed as { id?: string })?.id ?? 'r1' }));
      } else if (req.method === 'GET' && /^\/engine\/runs\/[^/]+$/.test(url)) {
        // dryRunRoutine doesn't use this, but the chat-action server's
        // happy-path does — keep responses cheap and valid.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ steps: [] }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
    });
  });

  await new Promise<void>((resolve) => {
    mockServer.listen(0, '127.0.0.1', () => {
      serverPort = (mockServer.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
});

// ── Helpers ─────────────────────────────────────────────────────

function makeMockWebContents() {
  return {
    isDestroyed: () => false,
    send: vi.fn(),
    ipc: { on: vi.fn(), removeListener: vi.fn() },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeMockRuntime() {
  return {
    startRun: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function step(overrides: Partial<StepDefinition> & { id: string; actionType: string }): StepDefinition {
  return {
    name: overrides.id,
    params: {},
    dependsOn: [],
    inputMappings: [],
    requiresApproval: false,
    onError: 'fail',
    ...overrides,
  };
}

function makeEngine(): ExecutionEngine {
  return new ExecutionEngine(serverPort, makeMockRuntime(), new EventEmitter());
}

// ── Tests ────────────────────────────────────────────────────────

describe('dryRunRoutine — happy paths', () => {
  it('a single ask_ai → send_notification routine completes ok with both steps marked completed', async () => {
    const engine = makeEngine();
    const dag: DAGDefinition = {
      steps: [
        step({
          id: 's1',
          name: 'Summarize',
          actionType: 'ask_ai',
          params: { prompt: 'Summarize the news', agent: 'cerebro' },
        }),
        step({
          id: 's2',
          name: 'Notify',
          actionType: 'send_notification',
          dependsOn: ['s1'],
          inputMappings: [
            { sourceStepId: 's1', sourceField: 'response', targetField: 'summary' },
          ],
          params: { title: 'Daily summary', body: '{{summary}}' },
        }),
      ],
    };

    const result = await engine.dryRunRoutine(makeMockWebContents(), { dag });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]).toMatchObject({ stepId: 's1', status: 'completed' });
    expect(result.steps[1]).toMatchObject({ stepId: 's2', status: 'completed' });
  });

  it('runs HubSpot create-ticket without a configured HubSpot channel — stubs replace execute', async () => {
    const engine = makeEngine();
    const dag: DAGDefinition = {
      steps: [
        step({
          id: 'ticket',
          name: 'Open ticket',
          actionType: 'hubspot_create_ticket',
          params: {
            subject: 'Customer cannot log in',
            content: 'Reported via Telegram bot',
          },
        }),
      ],
    };

    const result = await engine.dryRunRoutine(makeMockWebContents(), { dag });

    expect(result.ok).toBe(true);
    // The summary should make it obvious to the human reviewing the dry-run
    // log that we did NOT actually hit HubSpot.
    expect(result.steps[0].summary).toContain('[dry-run]');
  });

  it('exercises a Telegram message routine without a paired Telegram bot', async () => {
    const engine = makeEngine();
    const dag: DAGDefinition = {
      steps: [
        step({
          id: 'tg',
          name: 'Send Telegram',
          actionType: 'send_telegram_message',
          params: { chat_id: '123', message: 'Daily standup time!' },
        }),
      ],
    };

    const result = await engine.dryRunRoutine(makeMockWebContents(), { dag });
    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe('completed');
  });

  it('chains LLM steps via inputMappings — dry-run carries values forward via stub data', async () => {
    const engine = makeEngine();
    const dag: DAGDefinition = {
      steps: [
        step({
          id: 'classify',
          name: 'Classify intent',
          actionType: 'classify',
          params: { prompt: 'Is this a complaint?', categories: ['complaint', 'praise'] },
        }),
        step({
          id: 'summarize',
          name: 'Summarize',
          actionType: 'summarize',
          dependsOn: ['classify'],
          inputMappings: [
            { sourceStepId: 'classify', sourceField: 'category', targetField: 'context' },
          ],
          params: { input_field: 'Summarize this {{context}}' },
        }),
        step({
          id: 'notify',
          name: 'Notify',
          actionType: 'send_notification',
          dependsOn: ['summarize'],
          inputMappings: [
            { sourceStepId: 'summarize', sourceField: 'summary', targetField: 'body' },
          ],
          params: { title: 'Triage result', body: '{{body}}' },
        }),
      ],
    };

    const result = await engine.dryRunRoutine(makeMockWebContents(), { dag });
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.status)).toEqual(['completed', 'completed', 'completed']);
  });

  it('auto-passes approval gates so a routine packed with them still finishes', async () => {
    const engine = makeEngine();
    const dag: DAGDefinition = {
      steps: [
        step({
          id: 's1',
          name: 'Compose',
          actionType: 'ask_ai',
          params: { prompt: 'Draft a tweet', agent: 'cerebro' },
        }),
        step({
          id: 'gate',
          name: 'Confirm',
          actionType: 'approval_gate',
          dependsOn: ['s1'],
          requiresApproval: true,
          params: { summary: 'Confirm the tweet' },
        }),
        step({
          id: 'send',
          name: 'Send',
          actionType: 'send_telegram_message',
          dependsOn: ['gate'],
          inputMappings: [
            { sourceStepId: 's1', sourceField: 'response', targetField: 'msg' },
          ],
          requiresApproval: true,
          params: { chat_id: '999', message: '{{msg}}' },
        }),
      ],
    };

    const result = await engine.dryRunRoutine(makeMockWebContents(), { dag });
    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(result.steps.every((s) => s.status === 'completed')).toBe(true);
  });

  it('routes through trigger_payload — telegram-trigger routine reads {{trigger.chat_id}}', async () => {
    const engine = makeEngine();
    const dag: DAGDefinition = {
      steps: [
        step({
          id: 'reply',
          name: 'Reply',
          actionType: 'send_telegram_message',
          inputMappings: [
            { sourceStepId: '__trigger__', sourceField: 'chat_id', targetField: 'inbound_chat' },
          ],
          params: { chat_id: '{{inbound_chat}}', message: 'Got it!' },
        }),
      ],
    };

    const result = await engine.dryRunRoutine(makeMockWebContents(), {
      dag,
      triggerPayload: { chat_id: '5551234' },
    });
    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe('completed');
  });
});

describe('dryRunRoutine — failure paths the user needs to see before saving', () => {
  it('flags a step that omits a required param (no template used)', async () => {
    const engine = makeEngine();
    const dag: DAGDefinition = {
      steps: [
        step({
          id: 'tg',
          name: 'Send Telegram',
          actionType: 'send_telegram_message',
          // chat_id is required but missing.
          params: { message: 'Hello' },
        }),
      ],
    };

    const result = await engine.dryRunRoutine(makeMockWebContents(), { dag });
    expect(result.ok).toBe(false);
    expect(result.failedStepId).toBe('tg');
    expect(result.steps[0].status).toBe('failed');
    expect(result.steps[0].error).toMatch(/chat_id/);
  });

  it('flags a template that points at a variable no upstream step produces', async () => {
    const engine = makeEngine();
    const dag: DAGDefinition = {
      steps: [
        step({
          id: 's1',
          name: 'Summarize',
          actionType: 'ask_ai',
          params: { prompt: 'Hello', agent: 'cerebro' },
        }),
        step({
          id: 'send',
          name: 'Send',
          actionType: 'send_telegram_message',
          dependsOn: ['s1'],
          // The template references `{{customer_phone}}` but the upstream
          // step doesn't expose that field — and there's no inputMapping
          // wiring it. After rendering, chat_id is empty.
          params: { chat_id: '{{customer_phone}}', message: 'Hi!' },
        }),
      ],
    };

    const result = await engine.dryRunRoutine(makeMockWebContents(), { dag });
    expect(result.ok).toBe(false);
    expect(result.failedStepId).toBe('send');
    expect(result.steps[1].error).toMatch(/empty after template rendering/);
  });

  it('flags an unknown actionType at validation time', async () => {
    const engine = makeEngine();
    const dag: DAGDefinition = {
      steps: [
        step({
          id: 'mystery',
          name: 'Mystery',
          actionType: 'this_does_not_exist',
          params: {},
        }),
      ],
    };

    const result = await engine.dryRunRoutine(makeMockWebContents(), { dag });
    expect(result.ok).toBe(false);
    // validateDAG throws synchronously before the run starts → reaches
    // dryRunRoutine's outer catch.
    expect(result.error).toMatch(/this_does_not_exist|action/i);
  });

  it("doesn't pollute upstream steps' status when a downstream step fails", async () => {
    const engine = makeEngine();
    const dag: DAGDefinition = {
      steps: [
        step({
          id: 'good',
          name: 'Search',
          actionType: 'search_memory',
          params: { query: 'projects' },
        }),
        step({
          id: 'bad',
          name: 'Send',
          actionType: 'send_telegram_message',
          dependsOn: ['good'],
          // Missing chat_id.
          params: { message: 'No recipient' },
        }),
      ],
    };

    const result = await engine.dryRunRoutine(makeMockWebContents(), { dag });
    expect(result.ok).toBe(false);
    expect(result.steps[0].status).toBe('completed');
    expect(result.steps[1].status).toBe('failed');
  });
});

describe('dryRunRoutine — control flow still executes', () => {
  it('delay action runs but with the configured duration (capped duration not enforced — author should keep it small)', async () => {
    const engine = makeEngine();
    const dag: DAGDefinition = {
      steps: [
        step({
          id: 'wait',
          name: 'Wait',
          actionType: 'delay',
          params: { duration: 0, unit: 'seconds' },
        }),
        step({
          id: 'notify',
          name: 'Notify',
          actionType: 'send_notification',
          dependsOn: ['wait'],
          params: { title: 'After delay', body: 'ok' },
        }),
      ],
    };

    const result = await engine.dryRunRoutine(makeMockWebContents(), { dag });
    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe('completed');
    expect(result.steps[1].status).toBe('completed');
  });
});
