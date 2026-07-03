/**
 * n8n execution actions — run a workflow manually and inspect execution
 * history/failures via the public REST API:
 *
 *   n8n_run_workflow       write — manual trigger of a workflow by id
 *   n8n_list_executions    read-only — history, filterable by workflow/status
 *   n8n_get_execution      read-only — one execution incl. per-node errors
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import { n8nActionDefaults, requireN8nChannel, type N8nChannelDeps } from './n8n-channel';
import { callN8nApi } from '../../n8n/api';

interface ExecutionSummary {
  id: number | string;
  workflowId?: string;
  status?: string;
  mode?: string;
  startedAt?: string;
  stoppedAt?: string;
  finished?: boolean;
}

interface ExecutionDetail extends ExecutionSummary {
  data?: {
    resultData?: {
      error?: { message?: string; description?: string; node?: { name?: string } };
      lastNodeExecuted?: string;
    };
  };
  workflowData?: { name?: string };
}

export function createN8nExecutionActions(deps: N8nChannelDeps): ActionDefinition[] {
  const common = n8nActionDefaults(deps);

  const runWorkflow: ActionDefinition = {
    type: 'n8n_run_workflow',
    name: 'n8n: Run Workflow',
    description:
      'Manually execute an n8n workflow by id, optionally passing input data. The workflow runs immediately regardless of its triggers.',
    ...common,
    chatLabel: { en: 'Run n8n workflow', es: 'Ejecutar flujo de n8n' },
    chatDescription: {
      en: 'Execute a workflow right now, without waiting for its trigger. Optionally pass JSON input data to the first node.',
      es: 'Ejecuta un flujo ahora mismo, sin esperar a su disparador. Opcionalmente pasa datos JSON de entrada al primer nodo.',
    },
    chatExamples: [
      {
        en: 'Run my daily-report n8n workflow now.',
        es: 'Ejecuta ahora mi flujo de n8n del informe diario.',
      },
    ],
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'n8n workflow id. Templated.' },
        input_data: {
          type: ['object', 'string'],
          description: 'Optional JSON payload handed to the workflow as input.',
        },
      },
      required: ['workflow_id'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        started: { type: 'boolean' },
        workflow_id: { type: ['string', 'null'] },
        execution_id: { type: ['string', 'null'] },
        status: { type: ['string', 'null'] },
        error: { type: ['string', 'null'] },
      },
      required: ['started'],
    },
    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const { apiKey, baseUrl } = requireN8nChannel(deps, 'n8n: Run Workflow');
      const params = input.params as { workflow_id?: string; input_data?: unknown };
      const vars = input.wiredInputs ?? {};
      const workflowId = renderTemplate(params.workflow_id ?? '', vars).trim();
      if (!workflowId) throw new Error('n8n: Run Workflow — workflow_id is required.');

      let inputData: unknown;
      if (typeof params.input_data === 'string' && params.input_data.trim()) {
        try {
          inputData = JSON.parse(renderTemplate(params.input_data, vars));
        } catch {
          throw new Error('n8n: Run Workflow — input_data is not valid JSON.');
        }
      } else if (params.input_data && typeof params.input_data === 'object') {
        inputData = params.input_data;
      }

      const fail = (msg: string): ActionOutput => ({
        data: {
          started: false,
          workflow_id: workflowId,
          execution_id: null,
          status: null,
          error: msg,
        },
        summary: `n8n run workflow failed: ${msg}`,
      });

      // Preferred: the public execute endpoint (newer n8n versions).
      const res = await callN8nApi<{
        executionId?: string | number;
        id?: string | number;
        status?: string;
        data?: { executionId?: string | number };
      }>(baseUrl, apiKey, `/workflows/${encodeURIComponent(workflowId)}/execute`, {
        method: 'POST',
        body: inputData !== undefined ? { data: inputData } : {},
        signal: input.context.signal,
      });
      if (res.ok) {
        const raw = res.data ?? {};
        const executionId = raw.executionId ?? raw.id ?? raw.data?.executionId ?? null;
        input.context.log(`n8n run_workflow: ${workflowId} → execution ${executionId ?? '?'}`);
        return {
          data: {
            started: true,
            workflow_id: workflowId,
            execution_id: executionId !== null ? String(executionId) : null,
            status: raw.status ?? null,
            error: null,
          },
          summary: `Started n8n workflow ${workflowId}${executionId !== null ? ` (execution ${executionId})` : ''}`,
        };
      }
      if (res.status !== 404 && res.status !== 405) {
        input.context.log(`n8n run_workflow ${res.status}: ${res.error}`);
        return fail(res.error ?? `HTTP ${res.status}`);
      }

      // Fallback for versions without the execute endpoint (e.g. 2.28.x):
      // call the workflow's own production webhook trigger. Requires the
      // workflow to be active and to have a Webhook node.
      input.context.log('n8n run_workflow: no public execute endpoint — trying webhook trigger');
      const wfRes = await callN8nApi<{
        active?: boolean;
        name?: string;
        nodes?: Array<{
          type?: string;
          disabled?: boolean;
          parameters?: { path?: string; httpMethod?: string };
        }>;
      }>(baseUrl, apiKey, `/workflows/${encodeURIComponent(workflowId)}`, {
        signal: input.context.signal,
      });
      if (!wfRes.ok) {
        return fail(wfRes.error ?? `HTTP ${wfRes.status}`);
      }
      const webhookNode = (wfRes.data?.nodes ?? []).find(
        (n) => n.type === 'n8n-nodes-base.webhook' && !n.disabled && n.parameters?.path,
      );
      if (!webhookNode) {
        return fail(
          'This n8n version has no manual-run API and the workflow has no webhook trigger. Add a Webhook node, or run it from the canvas Test button in Flows.',
        );
      }
      if (!wfRes.data?.active) {
        return fail(
          'The workflow is inactive, so its webhook trigger is not listening. Activate it first (n8n_activate_workflow), then run it again.',
        );
      }
      const method = (webhookNode.parameters!.httpMethod ?? 'GET').toUpperCase();
      const webhookUrl = `${baseUrl}/webhook/${webhookNode.parameters!.path}`;
      let hookResponse: Response;
      try {
        hookResponse = await fetch(webhookUrl, {
          method,
          headers: method !== 'GET' ? { 'Content-Type': 'application/json' } : undefined,
          body: method !== 'GET' ? JSON.stringify(inputData ?? {}) : undefined,
          signal: input.context.signal,
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      if (!hookResponse.ok) {
        return fail(`Webhook trigger returned HTTP ${hookResponse.status}`);
      }
      input.context.log(
        `n8n run_workflow: ${workflowId} started via webhook trigger (${method} ${webhookUrl})`,
      );
      return {
        data: {
          started: true,
          workflow_id: workflowId,
          execution_id: null,
          status: 'started',
          error: null,
        },
        summary: `Started n8n workflow ${workflowId} via its webhook trigger — check n8n_list_executions for the result`,
      };
    },
  };

  const listExecutions: ActionDefinition = {
    type: 'n8n_list_executions',
    name: 'n8n: List Executions',
    description:
      'List recent n8n workflow executions, filterable by workflow id and status (success/error/waiting). Read-only.',
    ...common,
    readOnly: true,
    chatLabel: { en: 'List n8n executions', es: 'Listar ejecuciones de n8n' },
    chatDescription: {
      en: 'List recent workflow runs with status and timing. Filter by workflow and by status ("error" finds failures). Read-only.',
      es: 'Lista las ejecuciones recientes con estado y tiempos. Filtra por flujo y por estado ("error" encuentra fallos). Solo lectura.',
    },
    chatExamples: [
      {
        en: 'Why did my Slack-notify flow fail this morning?',
        es: '¿Por qué falló esta mañana mi flujo de avisos de Slack?',
      },
      {
        en: 'Show the last runs of my n8n workflows.',
        es: 'Muestra las últimas ejecuciones de mis flujos de n8n.',
      },
    ],
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'Filter by workflow id. Templated.' },
        status: {
          type: 'string',
          enum: ['success', 'error', 'waiting'],
          description: 'Filter by execution status.',
        },
        limit: { type: 'number', description: 'Max results (default 20).' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number' },
        executions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              execution_id: { type: 'string' },
              workflow_id: { type: ['string', 'null'] },
              status: { type: ['string', 'null'] },
              started_at: { type: ['string', 'null'] },
              stopped_at: { type: ['string', 'null'] },
            },
          },
        },
        error: { type: ['string', 'null'] },
      },
      required: ['count', 'executions'],
    },
    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const { apiKey, baseUrl } = requireN8nChannel(deps, 'n8n: List Executions');
      const params = input.params as { workflow_id?: string; status?: string; limit?: number };
      const vars = input.wiredInputs ?? {};
      const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 100);
      const query = new URLSearchParams({ limit: String(limit) });
      const workflowId = renderTemplate(params.workflow_id ?? '', vars).trim();
      if (workflowId) query.set('workflowId', workflowId);
      if (params.status) query.set('status', params.status);

      const res = await callN8nApi<{ data?: ExecutionSummary[] }>(
        baseUrl,
        apiKey,
        `/executions?${query.toString()}`,
        { signal: input.context.signal },
      );
      if (!res.ok) {
        input.context.log(`n8n list_executions ${res.status}: ${res.error}`);
        return {
          data: { count: 0, executions: [], error: res.error },
          summary: `n8n list executions failed: ${res.error}`,
        };
      }
      const executions = (res.data?.data ?? []).map((e) => ({
        execution_id: String(e.id),
        workflow_id: e.workflowId ?? null,
        status: e.status ?? (e.finished ? 'success' : null),
        started_at: e.startedAt ?? null,
        stopped_at: e.stoppedAt ?? null,
      }));
      input.context.log(`n8n list_executions: ${executions.length} execution(s)`);
      return {
        data: { count: executions.length, executions, error: null },
        summary: `${executions.length} n8n execution(s)`,
      };
    },
  };

  const getExecution: ActionDefinition = {
    type: 'n8n_get_execution',
    name: 'n8n: Get Execution',
    description:
      'Fetch one n8n execution by id, including the failing node and error message when it failed. Read-only.',
    ...common,
    readOnly: true,
    chatLabel: { en: 'Get n8n execution', es: 'Obtener ejecución de n8n' },
    chatDescription: {
      en: 'Inspect a single workflow run: status, timing, and — for failures — which node failed and why. Read-only.',
      es: 'Inspecciona una ejecución: estado, tiempos y — si falló — qué nodo falló y por qué. Solo lectura.',
    },
    chatExamples: [
      {
        en: 'What exactly failed in n8n execution 1234?',
        es: '¿Qué falló exactamente en la ejecución 1234 de n8n?',
      },
    ],
    inputSchema: {
      type: 'object',
      properties: {
        execution_id: { type: 'string', description: 'n8n execution id. Templated.' },
      },
      required: ['execution_id'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        found: { type: 'boolean' },
        execution_id: { type: ['string', 'null'] },
        workflow_id: { type: ['string', 'null'] },
        workflow_name: { type: ['string', 'null'] },
        status: { type: ['string', 'null'] },
        started_at: { type: ['string', 'null'] },
        stopped_at: { type: ['string', 'null'] },
        failed_node: { type: ['string', 'null'] },
        error_message: { type: ['string', 'null'] },
        last_node_executed: { type: ['string', 'null'] },
        error: { type: ['string', 'null'] },
      },
      required: ['found'],
    },
    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const { apiKey, baseUrl } = requireN8nChannel(deps, 'n8n: Get Execution');
      const params = input.params as { execution_id?: string };
      const vars = input.wiredInputs ?? {};
      const executionId = renderTemplate(params.execution_id ?? '', vars).trim();
      if (!executionId) throw new Error('n8n: Get Execution — execution_id is required.');

      const res = await callN8nApi<ExecutionDetail>(
        baseUrl,
        apiKey,
        `/executions/${encodeURIComponent(executionId)}?includeData=true`,
        { signal: input.context.signal },
      );
      if (!res.ok) {
        const notFound = res.status === 404;
        input.context.log(`n8n get_execution ${res.status}: ${res.error}`);
        return {
          data: {
            found: false,
            execution_id: executionId,
            workflow_id: null,
            workflow_name: null,
            status: null,
            started_at: null,
            stopped_at: null,
            failed_node: null,
            error_message: null,
            last_node_executed: null,
            error: notFound ? null : res.error,
          },
          summary: notFound
            ? `n8n execution ${executionId} not found`
            : `n8n get_execution failed: ${res.error}`,
        };
      }
      const exec = res.data!;
      const resultData = exec.data?.resultData;
      const failure = resultData?.error;
      const status = exec.status ?? (exec.finished ? 'success' : 'unknown');
      const summaryTail = failure
        ? ` — failed at "${failure.node?.name ?? 'unknown node'}": ${failure.message ?? 'unknown error'}`
        : '';
      return {
        data: {
          found: true,
          execution_id: String(exec.id),
          workflow_id: exec.workflowId ?? null,
          workflow_name: exec.workflowData?.name ?? null,
          status,
          started_at: exec.startedAt ?? null,
          stopped_at: exec.stoppedAt ?? null,
          failed_node: failure?.node?.name ?? null,
          error_message: failure ? (failure.message ?? failure.description ?? null) : null,
          last_node_executed: resultData?.lastNodeExecuted ?? null,
          error: null,
        },
        summary: `n8n execution ${executionId}: ${status}${summaryTail}`,
      };
    },
  };

  return [runWorkflow, listExecutions, getExecution];
}
