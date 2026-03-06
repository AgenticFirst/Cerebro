/**
 * Tool registry — creates the tool set for an expert.
 */

import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolContext } from '../types';
import {
  createRecallFacts,
  createRecallKnowledge,
  createSaveFact,
  createSaveEntry,
} from './memory-tools';
import { createGetCurrentTime, createGetUserProfile } from './system-tools';
import { createWebSearch } from './search-tools';
import { createRunRoutine, createProposeRoutine } from './routine-tools';
import { createProposeExpert } from './expert-proposal-tools';
import { createProposeTeam } from './team-proposal-tools';
import { createDelegateToExpert, createDelegateToTeam, createListExperts } from './delegation-tools';

/** All available tool factories, keyed by name. */
const TOOL_FACTORIES: Record<string, (ctx: ToolContext) => AgentTool> = {
  recall_facts: createRecallFacts,
  recall_knowledge: createRecallKnowledge,
  save_fact: createSaveFact,
  save_entry: createSaveEntry,
  get_current_time: (_ctx) => createGetCurrentTime(),
  get_user_profile: createGetUserProfile,
  web_search: createWebSearch,
  run_routine: createRunRoutine,
  propose_routine: createProposeRoutine,
  propose_expert: createProposeExpert,
  propose_team: createProposeTeam,
  delegate_to_expert: createDelegateToExpert,
  delegate_to_team: createDelegateToTeam,
  list_experts: createListExperts,
};

/** Default tool set that every expert gets. */
const DEFAULT_TOOLS = [
  'recall_facts',
  'recall_knowledge',
  'save_fact',
  'save_entry',
  'get_current_time',
  'get_user_profile',
  'web_search',
  'run_routine',
  'propose_routine',
];

/** Tools only available to Cerebro (personal scope), not individual experts. */
const CEREBRO_TOOLS = [
  'delegate_to_expert',
  'delegate_to_team',
  'list_experts',
  'propose_routine',
  'propose_expert',
  'propose_team',
  'run_routine',
];

/**
 * Build the tools array for a given expert.
 * If `toolAccess` is provided, only include those tools.
 * Otherwise include the default set, plus Cerebro-only tools for personal scope.
 */
export function createToolsForExpert(
  ctx: ToolContext,
  toolAccess?: string[] | null,
): AgentTool[] {
  let toolNames: string[];

  if (toolAccess && toolAccess.length > 0) {
    // Explicit tool access list — use as-is
    toolNames = toolAccess;
  } else if (ctx.scope === 'personal') {
    // Cerebro (personal scope) gets default + Cerebro-only tools
    toolNames = [...DEFAULT_TOOLS, ...CEREBRO_TOOLS.filter((t) => !DEFAULT_TOOLS.includes(t))];
  } else {
    // Individual experts get the default set (no delegation/routing tools)
    toolNames = DEFAULT_TOOLS.filter((t) => !CEREBRO_TOOLS.includes(t));
  }

  const tools: AgentTool[] = [];
  for (const name of toolNames) {
    const factory = TOOL_FACTORIES[name];
    if (factory) {
      tools.push(factory(ctx));
    }
  }

  return tools;
}
