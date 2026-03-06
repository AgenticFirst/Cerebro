/**
 * Team proposal tool for the agent system.
 * Allows Cerebro to propose creating a new team of experts.
 */

import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolContext } from '../types';
import { backendRequest, textResult, isSimilarName } from './tool-utils';

interface ExpertRecord {
  id: string;
  name: string;
  type: string;
}

export function createProposeTeam(ctx: ToolContext): AgentTool {
  return {
    name: 'propose_team',
    description:
      'Propose creating a new team of experts. A team coordinates multiple experts to work on tasks together, ' +
      'either sequentially (pipeline with context chaining) or in parallel (fan-out). ' +
      'Members can reference existing experts by ID or describe new experts to be created. ' +
      'The proposal will be shown inline for the user to review and save.',
    label: 'Propose Team',
    parameters: Type.Object({
      name: Type.String({
        description: 'Short, descriptive team name (e.g. "Content Team", "Code Review Pipeline")',
      }),
      description: Type.String({
        description: 'Brief description of what this team does and when to use it (1-2 sentences)',
      }),
      strategy: Type.Union(
        [Type.Literal('sequential'), Type.Literal('parallel'), Type.Literal('auto')],
        {
          description:
            'Execution strategy: "sequential" for pipeline (each member builds on previous output), ' +
            '"parallel" for independent fan-out, "auto" to let Cerebro decide per task.',
        },
      ),
      members: Type.Array(
        Type.Object({
          expert_id: Type.Optional(
            Type.String({
              description: 'ID of an existing expert. Omit to describe a new expert to create.',
            }),
          ),
          name: Type.Optional(
            Type.String({
              description: 'Name for a new expert (required if expert_id is not provided)',
            }),
          ),
          role: Type.String({
            description: 'Role this member plays in the team (e.g. "researcher", "reviewer", "editor")',
          }),
          description: Type.Optional(
            Type.String({
              description: 'Description for a new expert (required if expert_id is not provided)',
            }),
          ),
          order: Type.Optional(
            Type.Number({
              description: 'Execution order (0-based). Only matters for sequential strategy.',
            }),
          ),
        }),
        {
          description: 'Team members — reference existing experts or describe new ones to create.',
          minItems: 2,
        },
      ),
      coordinator_prompt: Type.Optional(
        Type.String({
          description:
            'Optional instructions for how results should be synthesized. ' +
            'Example: "Prioritize accuracy over speed. Flag any disagreements between members."',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      // Validate existing expert references
      for (const member of params.members) {
        if (member.expert_id) {
          try {
            const expert = await backendRequest<ExpertRecord>(
              ctx.backendPort,
              'GET',
              `/experts/${member.expert_id}`,
            );
            // Enrich member with name from existing expert
            if (!member.name) member.name = expert.name;
          } catch {
            return textResult(
              `Expert with ID "${member.expert_id}" not found. Use \`list_experts\` to find valid expert IDs.`,
            );
          }
        } else if (!member.name) {
          return textResult(
            `Member with role "${member.role}" needs either an expert_id (existing expert) or a name (new expert).`,
          );
        }
        // Auto-fill description from role if not provided
        if (!member.expert_id && !member.description) {
          member.description = `${member.name ?? member.role} specialist`;
        }
      }

      // Check for duplicate teams
      try {
        const res = await backendRequest<{ experts: ExpertRecord[] }>(
          ctx.backendPort,
          'GET',
          '/experts?type=team&is_enabled=true&limit=200',
        );
        const duplicate = res.experts.find((e) => isSimilarName(e.name, params.name));
        if (duplicate) {
          return textResult(
            `A similar team already exists: "${duplicate.name}" (ID: ${duplicate.id}). ` +
            `Suggest delegating to them with \`delegate_to_team\` or ask the user if they want to update the existing one.`,
          );
        }
      } catch {
        // Non-critical
      }

      // Build proposal
      const proposal = {
        type: 'team_proposal',
        name: params.name,
        description: params.description,
        strategy: params.strategy,
        members: params.members.map((m, i) => ({
          expert_id: m.expert_id ?? null,
          name: m.name ?? null,
          role: m.role,
          description: m.description ?? null,
          order: m.order ?? i,
        })),
        coordinatorPrompt: params.coordinator_prompt ?? null,
      };

      return textResult(JSON.stringify(proposal));
    },
  };
}
