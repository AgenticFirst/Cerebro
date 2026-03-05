/**
 * Routine tools for the agent system.
 * Lets the LLM trigger routine execution and propose new routines from chat.
 */

import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolContext } from '../types';
import type { DAGDefinition } from '../../engine/dag/types';
import { backendRequest, textResult } from './tool-utils';

interface RoutineRecord {
  id: string;
  name: string;
  dag_json: string | null;
}

export function createRunRoutine(ctx: ToolContext): AgentTool {
  return {
    name: 'run_routine',
    description:
      'Run a saved routine by name or ID. Routines are automated workflows (DAGs) that the user has configured.',
    label: 'Run Routine',
    parameters: Type.Object({
      routine: Type.String({
        description: 'The routine name (case-insensitive) or ID',
      }),
    }),
    execute: async (_toolCallId, params) => {
      // 1. Fetch all routines and find match
      let routines: RoutineRecord[];
      try {
        const res = await backendRequest<{ routines: RoutineRecord[] }>(
          ctx.backendPort,
          'GET',
          '/routines?limit=200',
        );
        routines = res.routines;
      } catch (err) {
        return textResult(`Failed to fetch routines: ${err instanceof Error ? err.message : String(err)}`);
      }

      const query = params.routine.toLowerCase();
      const match = routines.find(
        (r) => r.id === params.routine || r.name.toLowerCase() === query,
      );

      if (!match) {
        const names = routines.map((r) => r.name).join(', ');
        return textResult(
          `Routine "${params.routine}" not found. Available routines: ${names || '(none)'}`,
        );
      }

      if (!match.dag_json) {
        return textResult(
          `Routine "${match.name}" has no DAG configured. Open it in the canvas editor to add steps.`,
        );
      }

      // 2. Bump backend metadata
      try {
        await backendRequest(ctx.backendPort, 'POST', `/routines/${match.id}/run`);
      } catch (err) {
        console.warn(`[run_routine] Failed to bump run metadata for "${match.name}":`, err);
      }

      // 3. Execute the DAG
      if (!ctx.executionEngine || !ctx.webContents) {
        return textResult('Execution engine is not available. Try again in a moment.');
      }

      let dag: DAGDefinition;
      try {
        dag = JSON.parse(match.dag_json);
      } catch {
        return textResult(`Routine "${match.name}" has invalid DAG configuration.`);
      }

      try {
        const runId = await ctx.executionEngine.startRun(ctx.webContents, {
          dag,
          routineId: match.id,
          triggerSource: 'chat',
        });
        return textResult(`Started routine "${match.name}".\n[ENGINE_RUN_ID:${runId}]`);
      } catch (err) {
        return textResult(
          `Failed to start routine "${match.name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

/**
 * Fuzzy name similarity check — returns true if names are close enough
 * to be considered duplicates. Uses token-based Jaccard overlap to avoid
 * false positives with short names (e.g. "AI" matching "AI Email Draft").
 */
function isSimilarName(a: string, b: string): boolean {
  const tokenize = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean);
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 || tb.length === 0) return false;

  // Exact match after normalization
  if (ta.join(' ') === tb.join(' ')) return true;

  // Jaccard similarity — require >60% token overlap
  const setA = new Set(ta);
  const setB = new Set(tb);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = new Set([...ta, ...tb]).size;
  return intersection / union > 0.6;
}

export function createProposeRoutine(ctx: ToolContext): AgentTool {
  return {
    name: 'propose_routine',
    description:
      'Propose saving a repeatable task as a routine. Use this when the user describes a workflow they want to automate or repeat regularly. The proposal will be shown inline for the user to preview, save, or dismiss. Each step should be a single, concrete action — not too granular (avoid "open browser") and not too vague (avoid "handle everything"). Aim for 3-7 steps.',
    label: 'Propose Routine',
    parameters: Type.Object({
      name: Type.String({
        description: 'Short, descriptive name for the routine (e.g. "Morning Standup Prep")',
      }),
      description: Type.Optional(
        Type.String({
          description: 'Brief description of what this routine does and why (1-2 sentences)',
        }),
      ),
      steps: Type.Array(Type.String(), {
        description: 'Ordered list of plain-english steps the routine should perform',
        minItems: 1,
      }),
      trigger_type: Type.Optional(
        Type.Union([Type.Literal('manual'), Type.Literal('cron'), Type.Literal('webhook')], {
          description: 'How the routine should be triggered. Default: manual. Use "cron" when the user wants something to run on a schedule (e.g. "every morning", "daily at 9am", "weekdays at 5pm").',
        }),
      ),
      cron_expression: Type.Optional(
        Type.String({
          description:
            'Standard 5-field cron expression (minute hour day-of-month month day-of-week) when trigger_type is "cron". ' +
            'Generate from the user\'s natural language schedule. Examples: ' +
            '"every day at 9am" → "0 9 * * *", ' +
            '"weekdays at 9am" → "0 9 * * 1-5", ' +
            '"every Monday at 8:30am" → "30 8 * * 1", ' +
            '"Mon/Wed/Fri at 2pm" → "0 14 * * 1,3,5". ' +
            'Day-of-week: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat.',
        }),
      ),
      default_runner_id: Type.Optional(
        Type.String({ description: 'Expert/runner ID to execute steps, if applicable' }),
      ),
      required_connections: Type.Optional(
        Type.Array(Type.String(), {
          description: 'External services this routine needs (e.g. ["web_search", "gmail"])',
        }),
      ),
      approval_gates: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Steps that require user approval before executing (exact step text from the steps array)',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      // Check for duplicate routines before proposing
      try {
        const res = await backendRequest<{ routines: RoutineRecord[] }>(
          ctx.backendPort,
          'GET',
          '/routines?limit=200',
        );
        const duplicate = res.routines.find((r) => isSimilarName(r.name, params.name));
        if (duplicate) {
          return textResult(
            `A similar routine already exists: "${duplicate.name}" (ID: ${duplicate.id}). ` +
            `Suggest running it with \`run_routine\` or ask the user if they want to edit the existing one instead of creating a duplicate.`,
          );
        }
      } catch {
        // Non-critical — proceed with proposal if backend is unreachable
      }

      const proposal = {
        type: 'routine_proposal',
        name: params.name,
        description: params.description ?? '',
        steps: params.steps,
        triggerType: params.trigger_type ?? 'manual',
        cronExpression: params.cron_expression,
        defaultRunnerId: params.default_runner_id,
        requiredConnections: params.required_connections ?? [],
        approvalGates: params.approval_gates ?? [],
      };
      return textResult(JSON.stringify(proposal));
    },
  };
}
