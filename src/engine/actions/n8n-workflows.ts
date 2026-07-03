/**
 * n8n workflow actions — full lifecycle against the managed local instance's
 * public REST API (/api/v1/workflows):
 *
 *   n8n_list_workflows        read-only
 *   n8n_get_workflow          read-only (full nodes/connections JSON)
 *   n8n_create_workflow       write — takes a complete workflow JSON
 *   n8n_update_workflow       write — full replace of nodes/connections
 *   n8n_activate_workflow     write
 *   n8n_deactivate_workflow   write
 *   n8n_delete_workflow       write — PERMANENT, copy says so explicitly
 *
 * Reads are readOnly: true (skip the approval gate); writes gate by default.
 * Create/update notify the Flows screen via channel.notifyWorkflowTouched()
 * so the embedded canvas follows along.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import { n8nActionDefaults, requireN8nChannel, type N8nChannelDeps } from './n8n-channel';
import { callN8nApi } from '../../n8n/api';

interface WorkflowSummary {
  id: string;
  name: string;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
  tags?: Array<{ id: string; name: string }>;
}

interface WorkflowDetail extends WorkflowSummary {
  nodes?: unknown[];
  connections?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

function editorUrlFor(baseUrl: string, workflowId: string): string {
  return `${baseUrl}/workflow/${workflowId}`;
}

/**
 * Accepts the workflow JSON as an object or a JSON string (routine templating
 * can only wire strings). Strips fields the public API rejects on create.
 */
function parseWorkflowJson(raw: unknown, actionName: string): Record<string, unknown> {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new Error(`${actionName} — workflow_json is not valid JSON.`);
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`${actionName} — workflow_json must be a JSON object.`);
  }
  const wf = obj as Record<string, unknown>;
  if (!Array.isArray(wf.nodes) || wf.nodes.length === 0) {
    throw new Error(`${actionName} — workflow_json.nodes must be a non-empty array.`);
  }
  if (!wf.connections || typeof wf.connections !== 'object') {
    // A single-node workflow legitimately has no connections; default to {}.
    wf.connections = {};
  }
  return {
    name: typeof wf.name === 'string' && wf.name ? wf.name : 'Cerebro workflow',
    nodes: wf.nodes,
    connections: wf.connections,
    settings:
      wf.settings && typeof wf.settings === 'object' ? wf.settings : { executionOrder: 'v1' },
  };
}

export function createN8nWorkflowActions(deps: N8nChannelDeps): ActionDefinition[] {
  const common = n8nActionDefaults(deps);

  const listWorkflows: ActionDefinition = {
    type: 'n8n_list_workflows',
    name: 'n8n: List Workflows',
    description:
      'List workflows in the local n8n instance, optionally filtered by name or active state. Read-only.',
    ...common,
    readOnly: true,
    chatLabel: { en: 'List n8n workflows', es: 'Listar flujos de n8n' },
    chatDescription: {
      en: 'List the automation workflows in n8n, with id, name, active state and editor link. Use it first to resolve a workflow name to its id. Read-only.',
      es: 'Lista los flujos de automatización de n8n, con id, nombre, estado y enlace al editor. Úsalo primero para resolver el nombre de un flujo a su id. Solo lectura.',
    },
    chatExamples: [
      { en: 'Show me my n8n workflows.', es: 'Muéstrame mis flujos de n8n.' },
      { en: 'Which n8n flows are active?', es: '¿Qué flujos de n8n están activos?' },
    ],
    inputSchema: {
      type: 'object',
      properties: {
        name_contains: {
          type: 'string',
          description: 'Case-insensitive substring filter on the workflow name. Templated.',
        },
        active: { type: 'boolean', description: 'Filter by active state.' },
        limit: { type: 'number', description: 'Max results (default 50).' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number' },
        workflows: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              workflow_id: { type: 'string' },
              name: { type: 'string' },
              active: { type: 'boolean' },
              updated_at: { type: ['string', 'null'] },
              editor_url: { type: 'string' },
            },
          },
        },
        error: { type: ['string', 'null'] },
      },
      required: ['count', 'workflows'],
    },
    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const { apiKey, baseUrl } = requireN8nChannel(deps, 'n8n: List Workflows');
      const params = input.params as { name_contains?: string; active?: boolean; limit?: number };
      const vars = input.wiredInputs ?? {};
      const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 200);
      const query = new URLSearchParams({ limit: String(limit) });
      if (typeof params.active === 'boolean') query.set('active', String(params.active));

      const res = await callN8nApi<{ data?: WorkflowSummary[] }>(
        baseUrl,
        apiKey,
        `/workflows?${query.toString()}`,
        { signal: input.context.signal },
      );
      if (!res.ok) {
        input.context.log(`n8n list_workflows ${res.status}: ${res.error}`);
        return {
          data: { count: 0, workflows: [], error: res.error },
          summary: `n8n list workflows failed: ${res.error}`,
        };
      }
      const nameFilter = renderTemplate(params.name_contains ?? '', vars)
        .trim()
        .toLowerCase();
      const workflows = (res.data?.data ?? [])
        .filter((w) => !nameFilter || w.name.toLowerCase().includes(nameFilter))
        .map((w) => ({
          workflow_id: w.id,
          name: w.name,
          active: Boolean(w.active),
          updated_at: w.updatedAt ?? null,
          editor_url: editorUrlFor(baseUrl, w.id),
        }));
      input.context.log(`n8n list_workflows: ${workflows.length} workflow(s)`);
      return {
        data: { count: workflows.length, workflows, error: null },
        summary: `${workflows.length} n8n workflow(s)`,
      };
    },
  };

  const getWorkflow: ActionDefinition = {
    type: 'n8n_get_workflow',
    name: 'n8n: Get Workflow',
    description:
      'Fetch one n8n workflow by id, including its full nodes/connections JSON. Read-only.',
    ...common,
    readOnly: true,
    chatLabel: { en: 'Get n8n workflow', es: 'Obtener flujo de n8n' },
    chatDescription: {
      en: 'Fetch a workflow by id with its complete nodes and connections JSON — the ground truth for node parameter shapes and typeVersions before editing. Read-only.',
      es: 'Obtiene un flujo por id con su JSON completo de nodos y conexiones — la referencia real de parámetros y typeVersions antes de editar. Solo lectura.',
    },
    chatExamples: [
      {
        en: 'Show me the nodes in my invoice-sync n8n workflow.',
        es: 'Muéstrame los nodos de mi flujo de n8n de sincronización de facturas.',
      },
    ],
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'n8n workflow id. Templated.' },
      },
      required: ['workflow_id'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        found: { type: 'boolean' },
        workflow_id: { type: ['string', 'null'] },
        name: { type: ['string', 'null'] },
        active: { type: ['boolean', 'null'] },
        workflow_json: {
          type: ['object', 'null'],
          description: 'Full workflow definition: name, nodes, connections, settings.',
        },
        editor_url: { type: ['string', 'null'] },
        error: { type: ['string', 'null'] },
      },
      required: ['found'],
    },
    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const { apiKey, baseUrl } = requireN8nChannel(deps, 'n8n: Get Workflow');
      const params = input.params as { workflow_id?: string };
      const vars = input.wiredInputs ?? {};
      const workflowId = renderTemplate(params.workflow_id ?? '', vars).trim();
      if (!workflowId) throw new Error('n8n: Get Workflow — workflow_id is required.');

      const res = await callN8nApi<WorkflowDetail>(
        baseUrl,
        apiKey,
        `/workflows/${encodeURIComponent(workflowId)}`,
        { signal: input.context.signal },
      );
      if (!res.ok) {
        const notFound = res.status === 404;
        input.context.log(`n8n get_workflow ${res.status}: ${res.error}`);
        return {
          data: {
            found: false,
            workflow_id: workflowId,
            name: null,
            active: null,
            workflow_json: null,
            editor_url: null,
            error: notFound ? null : res.error,
          },
          summary: notFound
            ? `n8n workflow ${workflowId} not found`
            : `n8n get_workflow failed: ${res.error}`,
        };
      }
      const wf = res.data!;
      return {
        data: {
          found: true,
          workflow_id: wf.id,
          name: wf.name,
          active: Boolean(wf.active),
          workflow_json: {
            name: wf.name,
            nodes: wf.nodes ?? [],
            connections: wf.connections ?? {},
            settings: wf.settings ?? {},
          },
          editor_url: editorUrlFor(baseUrl, wf.id),
          error: null,
        },
        summary: `n8n workflow "${wf.name}" (${wf.id})`,
      };
    },
  };

  const createWorkflow: ActionDefinition = {
    type: 'n8n_create_workflow',
    name: 'n8n: Create Workflow',
    description:
      'Create a new n8n workflow from a complete workflow JSON (name, nodes, connections, settings). Returns the id and an editor link. The workflow is created inactive — activate it separately.',
    ...common,
    chatLabel: { en: 'Create n8n workflow', es: 'Crear flujo de n8n' },
    chatDescription: {
      en: 'Create a new automation workflow in n8n from a full workflow JSON. It arrives inactive; offer to activate it after the user checks the canvas.',
      es: 'Crea un nuevo flujo de automatización en n8n a partir de un JSON completo. Se crea inactivo; ofrece activarlo cuando el usuario revise el lienzo.',
    },
    chatExamples: [
      {
        en: 'Build me an n8n flow that posts to Slack every morning at 9am.',
        es: 'Créame un flujo de n8n que publique en Slack cada mañana a las 9.',
      },
      {
        en: 'Automate syncing new webhook leads into HubSpot with n8n.',
        es: 'Automatiza con n8n la sincronización de leads del webhook a HubSpot.',
      },
    ],
    inputSchema: {
      type: 'object',
      properties: {
        workflow_json: {
          type: ['object', 'string'],
          description:
            'Complete workflow definition: { name, nodes: [...], connections: {...}, settings? }. Object or JSON string.',
        },
      },
      required: ['workflow_json'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        created: { type: 'boolean' },
        workflow_id: { type: ['string', 'null'] },
        name: { type: ['string', 'null'] },
        editor_url: { type: ['string', 'null'] },
        error: { type: ['string', 'null'] },
      },
      required: ['created'],
    },
    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const { channel, apiKey, baseUrl } = requireN8nChannel(deps, 'n8n: Create Workflow');
      const params = input.params as { workflow_json?: unknown };
      const body = parseWorkflowJson(params.workflow_json, 'n8n: Create Workflow');

      const res = await callN8nApi<WorkflowDetail>(baseUrl, apiKey, '/workflows', {
        method: 'POST',
        body,
        signal: input.context.signal,
      });
      if (!res.ok || !res.data?.id) {
        input.context.log(`n8n create_workflow ${res.status}: ${res.error}`);
        return {
          data: {
            created: false,
            workflow_id: null,
            name: null,
            editor_url: null,
            error: res.error,
          },
          summary: `n8n create workflow failed: ${res.error}`,
        };
      }
      const wf = res.data;
      channel.notifyWorkflowTouched(wf.id);
      input.context.log(`n8n create_workflow: "${wf.name}" → ${wf.id}`);
      return {
        data: {
          created: true,
          workflow_id: wf.id,
          name: wf.name,
          editor_url: editorUrlFor(baseUrl, wf.id),
          error: null,
        },
        summary: `Created n8n workflow "${wf.name}" (${wf.id})`,
      };
    },
  };

  const updateWorkflow: ActionDefinition = {
    type: 'n8n_update_workflow',
    name: 'n8n: Update Workflow',
    description:
      'Replace an existing n8n workflow definition (name, nodes, connections, settings) by id. Fetch the current JSON with n8n_get_workflow first and send back the full edited document.',
    ...common,
    chatLabel: { en: 'Update n8n workflow', es: 'Actualizar flujo de n8n' },
    chatDescription: {
      en: 'Replace a workflow definition by id. Always fetch the current JSON with n8n_get_workflow first, edit it, and send the complete document back — partial patches are not supported.',
      es: 'Reemplaza la definición de un flujo por id. Obtén primero el JSON actual con n8n_get_workflow, edítalo y envía el documento completo — no admite parches parciales.',
    },
    chatExamples: [
      {
        en: 'Add a Telegram alert step to my daily-report n8n flow.',
        es: 'Añade un aviso de Telegram a mi flujo de n8n del informe diario.',
      },
    ],
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'n8n workflow id. Templated.' },
        workflow_json: {
          type: ['object', 'string'],
          description: 'Complete replacement definition. Object or JSON string.',
        },
      },
      required: ['workflow_id', 'workflow_json'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        updated: { type: 'boolean' },
        workflow_id: { type: ['string', 'null'] },
        name: { type: ['string', 'null'] },
        editor_url: { type: ['string', 'null'] },
        error: { type: ['string', 'null'] },
      },
      required: ['updated'],
    },
    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const { channel, apiKey, baseUrl } = requireN8nChannel(deps, 'n8n: Update Workflow');
      const params = input.params as { workflow_id?: string; workflow_json?: unknown };
      const vars = input.wiredInputs ?? {};
      const workflowId = renderTemplate(params.workflow_id ?? '', vars).trim();
      if (!workflowId) throw new Error('n8n: Update Workflow — workflow_id is required.');
      const body = parseWorkflowJson(params.workflow_json, 'n8n: Update Workflow');

      const res = await callN8nApi<WorkflowDetail>(
        baseUrl,
        apiKey,
        `/workflows/${encodeURIComponent(workflowId)}`,
        { method: 'PUT', body, signal: input.context.signal },
      );
      if (!res.ok) {
        input.context.log(`n8n update_workflow ${res.status}: ${res.error}`);
        return {
          data: {
            updated: false,
            workflow_id: workflowId,
            name: null,
            editor_url: null,
            error: res.error,
          },
          summary: `n8n update workflow failed: ${res.error}`,
        };
      }
      channel.notifyWorkflowTouched(workflowId);
      const name = res.data?.name ?? (body.name as string);
      input.context.log(`n8n update_workflow: ${workflowId}`);
      return {
        data: {
          updated: true,
          workflow_id: workflowId,
          name,
          editor_url: editorUrlFor(baseUrl, workflowId),
          error: null,
        },
        summary: `Updated n8n workflow "${name}" (${workflowId})`,
      };
    },
  };

  const makeToggleAction = (activate: boolean): ActionDefinition => {
    const verb = activate ? 'Activate' : 'Deactivate';
    const type = activate ? 'n8n_activate_workflow' : 'n8n_deactivate_workflow';
    return {
      type,
      name: `n8n: ${verb} Workflow`,
      description: `${verb} an n8n workflow by id. ${activate ? 'Its triggers (webhooks, schedules) start firing.' : 'Its triggers stop firing.'}`,
      ...common,
      chatLabel: activate
        ? { en: 'Activate n8n workflow', es: 'Activar flujo de n8n' }
        : { en: 'Deactivate n8n workflow', es: 'Desactivar flujo de n8n' },
      chatDescription: activate
        ? {
            en: 'Turn a workflow on so its triggers (webhooks, schedules) run automatically.',
            es: 'Enciende un flujo para que sus disparadores (webhooks, horarios) se ejecuten automáticamente.',
          }
        : {
            en: 'Turn a workflow off so its triggers stop firing.',
            es: 'Apaga un flujo para que sus disparadores dejen de ejecutarse.',
          },
      chatExamples: activate
        ? [
            {
              en: 'Turn on the invoice-sync workflow.',
              es: 'Activa el flujo de sincronización de facturas.',
            },
          ]
        : [
            {
              en: 'Pause my daily-digest n8n flow.',
              es: 'Pausa mi flujo de n8n del resumen diario.',
            },
          ],
      inputSchema: {
        type: 'object',
        properties: {
          workflow_id: { type: 'string', description: 'n8n workflow id. Templated.' },
        },
        required: ['workflow_id'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          workflow_id: { type: ['string', 'null'] },
          active: { type: ['boolean', 'null'] },
          error: { type: ['string', 'null'] },
        },
        required: ['success'],
      },
      execute: async (input: ActionInput): Promise<ActionOutput> => {
        const { apiKey, baseUrl } = requireN8nChannel(deps, `n8n: ${verb} Workflow`);
        const params = input.params as { workflow_id?: string };
        const vars = input.wiredInputs ?? {};
        const workflowId = renderTemplate(params.workflow_id ?? '', vars).trim();
        if (!workflowId) throw new Error(`n8n: ${verb} Workflow — workflow_id is required.`);

        const res = await callN8nApi<WorkflowDetail>(
          baseUrl,
          apiKey,
          `/workflows/${encodeURIComponent(workflowId)}/${activate ? 'activate' : 'deactivate'}`,
          { method: 'POST', signal: input.context.signal },
        );
        if (!res.ok) {
          input.context.log(`n8n ${type} ${res.status}: ${res.error}`);
          return {
            data: { success: false, workflow_id: workflowId, active: null, error: res.error },
            summary: `n8n ${verb.toLowerCase()} failed: ${res.error}`,
          };
        }
        return {
          data: { success: true, workflow_id: workflowId, active: activate, error: null },
          summary: `${verb}d n8n workflow ${workflowId}`,
        };
      },
    };
  };

  const deleteWorkflow: ActionDefinition = {
    type: 'n8n_delete_workflow',
    name: 'n8n: Delete Workflow',
    description:
      'PERMANENTLY delete an n8n workflow by id. This cannot be undone — confirm the exact workflow (name + id) with the user before running.',
    ...common,
    chatLabel: { en: 'Delete n8n workflow', es: 'Eliminar flujo de n8n' },
    chatDescription: {
      en: 'Permanently deletes a workflow — there is no trash or undo in n8n. Always confirm the exact workflow name and id with the user first.',
      es: 'Elimina un flujo de forma permanente — n8n no tiene papelera ni deshacer. Confirma siempre el nombre y el id exactos con el usuario antes.',
    },
    chatExamples: [
      {
        en: 'Delete the old lead-import n8n workflow.',
        es: 'Elimina el flujo antiguo de n8n de importación de leads.',
      },
    ],
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'n8n workflow id. Templated.' },
      },
      required: ['workflow_id'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        deleted: { type: 'boolean' },
        workflow_id: { type: ['string', 'null'] },
        error: { type: ['string', 'null'] },
      },
      required: ['deleted'],
    },
    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const { apiKey, baseUrl } = requireN8nChannel(deps, 'n8n: Delete Workflow');
      const params = input.params as { workflow_id?: string };
      const vars = input.wiredInputs ?? {};
      const workflowId = renderTemplate(params.workflow_id ?? '', vars).trim();
      if (!workflowId) throw new Error('n8n: Delete Workflow — workflow_id is required.');

      const res = await callN8nApi(
        baseUrl,
        apiKey,
        `/workflows/${encodeURIComponent(workflowId)}`,
        { method: 'DELETE', signal: input.context.signal },
      );
      if (!res.ok) {
        input.context.log(`n8n delete_workflow ${res.status}: ${res.error}`);
        return {
          data: { deleted: false, workflow_id: workflowId, error: res.error },
          summary: `n8n delete workflow failed: ${res.error}`,
        };
      }
      input.context.log(`n8n delete_workflow: ${workflowId} permanently deleted`);
      return {
        data: { deleted: true, workflow_id: workflowId, error: null },
        summary: `Deleted n8n workflow ${workflowId} (permanent)`,
      };
    },
  };

  return [
    listWorkflows,
    getWorkflow,
    createWorkflow,
    updateWorkflow,
    makeToggleAction(true),
    makeToggleAction(false),
    deleteWorkflow,
  ];
}
