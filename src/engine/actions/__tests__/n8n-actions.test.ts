/**
 * Unit tests for the n8n workflow + execution actions.
 *
 * Mocks global.fetch (used by callN8nApi and the webhook fallback) so they
 * run offline. Asserts /api/v1 request shapes, the workflow-JSON parsing
 * (string or object, node validation), read/write flags, the Flows-screen
 * notify hook, the run-workflow webhook fallback, and error paths.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionContext, ActionInput } from '../types';
import type { N8nChannel } from '../n8n-channel';
import { createN8nWorkflowActions } from '../n8n-workflows';
import { createN8nExecutionActions } from '../n8n-executions';

const BASE = 'http://127.0.0.1:55678';

function buildChannel(
  opts: Partial<{ apiKey: string | null; connected: boolean }> = {},
): N8nChannel & { touched: string[] } {
  const touched: string[] = [];
  return {
    touched,
    getApiKey: () => (opts.apiKey === undefined ? 'test-key' : opts.apiKey),
    getEditorBaseUrl: () => BASE,
    isConnected: () => opts.connected ?? true,
    notifyWorkflowTouched: (id: string) => {
      touched.push(id);
    },
  };
}

function buildActionInput(
  params: Record<string, unknown>,
  wiredInputs: Record<string, unknown> = {},
): ActionInput {
  const context: ActionContext = {
    runId: 'test-run',
    stepId: 'test-step',
    backendPort: 0,
    signal: new AbortController().signal,
    log: () => {
      /* no-op */
    },
    emitEvent: () => {
      /* no-op */
    },
  };
  return {
    params,
    wiredInputs,
    scratchpad: {} as unknown as ActionInput['scratchpad'],
    context,
  };
}

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  let i = 0;
  const fn = vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function workflowActions(channel: N8nChannel) {
  const actions = createN8nWorkflowActions({ getChannel: () => channel });
  return Object.fromEntries(actions.map((a) => [a.type, a]));
}

function executionActions(channel: N8nChannel) {
  const actions = createN8nExecutionActions({ getChannel: () => channel });
  return Object.fromEntries(actions.map((a) => [a.type, a]));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('action metadata', () => {
  it('marks reads readOnly and writes not', () => {
    const all = { ...workflowActions(buildChannel()), ...executionActions(buildChannel()) };
    const readOnly = Object.values(all)
      .filter((a) => a.readOnly)
      .map((a) => a.type)
      .sort();
    expect(readOnly).toEqual([
      'n8n_get_execution',
      'n8n_get_workflow',
      'n8n_list_executions',
      'n8n_list_workflows',
    ]);
    for (const a of Object.values(all)) {
      expect(a.chatExposable).toBe(true);
      expect(a.chatGroup).toBe('n8n');
      expect(a.chatLabel?.en).toBeTruthy();
      expect(a.chatLabel?.es).toBeTruthy();
    }
  });

  it('reports not_connected when the instance is down', () => {
    const all = workflowActions(buildChannel({ connected: false }));
    expect(all.n8n_list_workflows.availabilityCheck?.()).toBe('not_connected');
  });
});

describe('n8n_list_workflows', () => {
  it('lists with the API key header and applies the name filter', async () => {
    const fetchMock = mockFetch(200, {
      data: [
        { id: 'A', name: 'Invoice sync', active: true, updatedAt: '2026-01-01' },
        { id: 'B', name: 'Daily digest', active: false },
      ],
    });
    const action = workflowActions(buildChannel()).n8n_list_workflows;
    const result = await action.execute(buildActionInput({ name_contains: 'invoice' }));

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(`${BASE}/api/v1/workflows?`);
    expect((init as RequestInit).headers).toMatchObject({ 'X-N8N-API-KEY': 'test-key' });

    expect(result.data.count).toBe(1);
    const workflows = result.data.workflows as Array<Record<string, unknown>>;
    expect(workflows[0].workflow_id).toBe('A');
    expect(workflows[0].editor_url).toBe(`${BASE}/workflow/A`);
  });

  it('throws when n8n is not running', async () => {
    const action = workflowActions(buildChannel({ connected: false })).n8n_list_workflows;
    await expect(action.execute(buildActionInput({}))).rejects.toThrow(/not running/);
  });
});

describe('n8n_create_workflow', () => {
  const validWorkflow = {
    name: 'Test flow',
    nodes: [
      {
        id: 'n1',
        name: 'Webhook',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        position: [0, 0],
        parameters: { path: 'x' },
      },
    ],
    connections: {},
  };

  it('POSTs the parsed workflow, notifies the Flows screen, returns editor_url', async () => {
    const fetchMock = mockFetch(200, { id: 'WF9', name: 'Test flow', active: false });
    const channel = buildChannel();
    const action = workflowActions(channel).n8n_create_workflow;
    // Passed as a JSON *string* — routine templating can only wire strings.
    const result = await action.execute(
      buildActionInput({ workflow_json: JSON.stringify(validWorkflow) }),
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${BASE}/api/v1/workflows`);
    expect((init as RequestInit).method).toBe('POST');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.name).toBe('Test flow');
    expect(sent.nodes).toHaveLength(1);
    expect(sent.settings).toEqual({ executionOrder: 'v1' });

    expect(result.data.created).toBe(true);
    expect(result.data.workflow_id).toBe('WF9');
    expect(result.data.editor_url).toBe(`${BASE}/workflow/WF9`);
    expect(channel.touched).toEqual(['WF9']);
  });

  it('rejects a workflow without nodes', async () => {
    const action = workflowActions(buildChannel()).n8n_create_workflow;
    await expect(
      action.execute(buildActionInput({ workflow_json: { name: 'empty', nodes: [] } })),
    ).rejects.toThrow(/nodes/);
  });

  it('surfaces API errors without throwing', async () => {
    mockFetch(400, { message: 'invalid node type' });
    const action = workflowActions(buildChannel()).n8n_create_workflow;
    const result = await action.execute(buildActionInput({ workflow_json: validWorkflow }));
    expect(result.data.created).toBe(false);
    expect(result.data.error).toBe('invalid node type');
  });
});

describe('n8n_activate_workflow / n8n_deactivate_workflow', () => {
  it('POSTs to the activate endpoint', async () => {
    const fetchMock = mockFetch(200, { id: 'WF1', active: true });
    const action = workflowActions(buildChannel()).n8n_activate_workflow;
    const result = await action.execute(buildActionInput({ workflow_id: 'WF1' }));
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${BASE}/api/v1/workflows/WF1/activate`);
    expect(result.data.success).toBe(true);
    expect(result.data.active).toBe(true);
  });
});

describe('n8n_delete_workflow', () => {
  it('DELETEs by id', async () => {
    const fetchMock = mockFetch(200, {});
    const action = workflowActions(buildChannel()).n8n_delete_workflow;
    const result = await action.execute(buildActionInput({ workflow_id: 'WF2' }));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${BASE}/api/v1/workflows/WF2`);
    expect((init as RequestInit).method).toBe('DELETE');
    expect(result.data.deleted).toBe(true);
  });
});

describe('n8n_run_workflow', () => {
  it('uses the public execute endpoint when available', async () => {
    const fetchMock = mockFetch(200, { executionId: 77 });
    const action = executionActions(buildChannel()).n8n_run_workflow;
    const result = await action.execute(buildActionInput({ workflow_id: 'WF1' }));
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${BASE}/api/v1/workflows/WF1/execute`);
    expect(result.data.started).toBe(true);
    expect(result.data.execution_id).toBe('77');
  });

  it('falls back to the webhook trigger when execute returns 405 (n8n 2.28.x)', async () => {
    const fetchMock = mockFetchSequence([
      { status: 405, body: { message: 'Method not allowed' } },
      {
        status: 200,
        body: {
          id: 'WF1',
          active: true,
          nodes: [
            {
              type: 'n8n-nodes-base.webhook',
              parameters: { path: 'my-hook', httpMethod: 'POST' },
            },
          ],
        },
      },
      { status: 200, body: { message: 'Workflow was started' } },
    ]);
    const action = executionActions(buildChannel()).n8n_run_workflow;
    const result = await action.execute(
      buildActionInput({ workflow_id: 'WF1', input_data: { hello: 'world' } }),
    );

    expect(String(fetchMock.mock.calls[2][0])).toBe(`${BASE}/webhook/my-hook`);
    expect((fetchMock.mock.calls[2][1] as RequestInit).method).toBe('POST');
    expect(result.data.started).toBe(true);
  });

  it('explains when the workflow is inactive so its webhook cannot fire', async () => {
    mockFetchSequence([
      { status: 405, body: {} },
      {
        status: 200,
        body: {
          id: 'WF1',
          active: false,
          nodes: [{ type: 'n8n-nodes-base.webhook', parameters: { path: 'p' } }],
        },
      },
    ]);
    const action = executionActions(buildChannel()).n8n_run_workflow;
    const result = await action.execute(buildActionInput({ workflow_id: 'WF1' }));
    expect(result.data.started).toBe(false);
    expect(String(result.data.error)).toMatch(/inactive/i);
  });

  it('explains when there is no webhook trigger at all', async () => {
    mockFetchSequence([
      { status: 405, body: {} },
      { status: 200, body: { id: 'WF1', active: true, nodes: [] } },
    ]);
    const action = executionActions(buildChannel()).n8n_run_workflow;
    const result = await action.execute(buildActionInput({ workflow_id: 'WF1' }));
    expect(result.data.started).toBe(false);
    expect(String(result.data.error)).toMatch(/webhook/i);
  });
});

describe('n8n_get_execution', () => {
  it('extracts the failing node and error message', async () => {
    mockFetch(200, {
      id: 42,
      status: 'error',
      workflowId: 'WF1',
      startedAt: '2026-01-01T00:00:00Z',
      stoppedAt: '2026-01-01T00:00:05Z',
      workflowData: { name: 'Invoice sync' },
      data: {
        resultData: {
          lastNodeExecuted: 'HTTP Request',
          error: { message: 'connect ECONNREFUSED', node: { name: 'HTTP Request' } },
        },
      },
    });
    const action = executionActions(buildChannel()).n8n_get_execution;
    const result = await action.execute(buildActionInput({ execution_id: '42' }));
    expect(result.data.found).toBe(true);
    expect(result.data.status).toBe('error');
    expect(result.data.failed_node).toBe('HTTP Request');
    expect(result.data.error_message).toBe('connect ECONNREFUSED');
    expect(result.data.workflow_name).toBe('Invoice sync');
  });

  it('reports not-found cleanly', async () => {
    mockFetch(404, { message: 'not found' });
    const action = executionActions(buildChannel()).n8n_get_execution;
    const result = await action.execute(buildActionInput({ execution_id: '999' }));
    expect(result.data.found).toBe(false);
    expect(result.data.error).toBeNull();
  });
});
