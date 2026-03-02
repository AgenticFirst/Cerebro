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

/** All available tool factories, keyed by name. */
const TOOL_FACTORIES: Record<string, (ctx: ToolContext) => AgentTool> = {
  recall_facts: createRecallFacts,
  recall_knowledge: createRecallKnowledge,
  save_fact: createSaveFact,
  save_entry: createSaveEntry,
  get_current_time: (_ctx) => createGetCurrentTime(),
  get_user_profile: createGetUserProfile,
  web_search: createWebSearch,
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
];

/**
 * Build the tools array for a given expert.
 * If `toolAccess` is provided, only include those tools.
 * Otherwise include the default set.
 */
export function createToolsForExpert(
  ctx: ToolContext,
  toolAccess?: string[] | null,
): AgentTool[] {
  const toolNames = toolAccess && toolAccess.length > 0 ? toolAccess : DEFAULT_TOOLS;
  const tools: AgentTool[] = [];

  for (const name of toolNames) {
    const factory = TOOL_FACTORIES[name];
    if (factory) {
      tools.push(factory(ctx));
    }
  }

  return tools;
}
