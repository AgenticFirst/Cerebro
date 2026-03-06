/**
 * Delegation tools — delegate_to_expert, delegate_to_team, and list_experts.
 * These are Cerebro-only tools that enable routing user requests to specialist experts and teams.
 */

import http from 'node:http';
import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolContext, RendererAgentEvent, SubAgentResult } from '../types';
import { resolveModel } from '../model-resolver';
import { classifyModelTier, type ModelTier } from '../loop/model-tiers';
import { backendRequest, textResult, isSimilarName } from './tool-utils';

interface ExpertRecord {
  id: string;
  name: string;
  domain: string | null;
  description: string;
  type: string;
  is_enabled: boolean;
}

interface ExpertListResponse {
  experts: ExpertRecord[];
  total: number;
}

// ── Team orchestration types ─────────────────────────────────────

interface TeamMemberRecord {
  expert_id: string;
  role: string;
  order: number;
  delegation_prompt: string | null;
  on_error: string;
  name?: string;
}

interface TeamExpertRecord extends ExpertRecord {
  team_members: TeamMemberRecord[] | null;
  strategy: string | null;
  coordinator_prompt: string | null;
}

interface MemberResult {
  memberId: string;
  memberName: string;
  role: string;
  status: 'completed' | 'error';
  content: string;
  error?: string;
}

const MAX_DELEGATION_DEPTH = 3;

export function createDelegateToExpert(ctx: ToolContext): AgentTool {
  return {
    name: 'delegate_to_expert',
    description:
      'Delegate a task to a specialist expert. The expert will run autonomously with their own system prompt and tools, then return their response. ' +
      'Provide a clear, complete task description — the expert cannot see your conversation history. ' +
      'Use the expert ID from the Available Experts catalog.',
    label: 'Delegate to Expert',
    parameters: Type.Object({
      expert_id: Type.String({
        description: 'The expert ID (from the [ID: xxx] in the expert catalog)',
      }),
      task: Type.String({
        description:
          'Clear, complete description of what the expert should do. Include all relevant context ' +
          'from the conversation since the expert cannot see chat history.',
      }),
      context: Type.Optional(
        Type.String({
          description:
            'Additional context the expert needs (user preferences, constraints, prior information). ' +
            'Include anything relevant that the expert would not know from their own system prompt.',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      // Validate we have the runtime and webContents
      if (!ctx.agentRuntime || !ctx.webContents) {
        return textResult('Delegation is not available in this context.');
      }

      // Depth limit: prevent infinite recursive delegation
      const currentDepth = ctx.delegationDepth ?? 0;
      if (currentDepth >= MAX_DELEGATION_DEPTH) {
        return textResult(
          `Delegation depth limit (${MAX_DELEGATION_DEPTH}) reached. Handle this task directly instead of delegating.`,
        );
      }

      // Fetch expert to validate it exists and is enabled
      let expert: ExpertRecord;
      try {
        expert = await backendRequest<ExpertRecord>(
          ctx.backendPort,
          'GET',
          `/experts/${params.expert_id}`,
        );
      } catch {
        return textResult(
          `Expert with ID "${params.expert_id}" not found. Use \`list_experts\` to see available experts.`,
        );
      }

      if (!expert.is_enabled) {
        return textResult(
          `Expert "${expert.name}" is currently disabled. The user can re-enable it in the Experts screen.`,
        );
      }

      // Compose the prompt from task + context
      let prompt = params.task;
      if (params.context) {
        prompt += `\n\nAdditional context:\n${params.context}`;
      }

      // Emit delegation_start event to the renderer
      const parentRunId = ctx.parentRunId!;
      const channel = `agent:event:${parentRunId}`;
      if (!ctx.webContents.isDestroyed()) {
        ctx.webContents.send(channel, {
          type: 'delegation_start',
          parentRunId,
          childRunId: '', // Will be filled after startRun
          expertId: expert.id,
          expertName: expert.name,
        } as RendererAgentEvent);
      }

      // Start the sub-agent run
      let childRunId: string;
      try {
        childRunId = await ctx.agentRuntime.startRun(ctx.webContents, {
          conversationId: `delegate:${parentRunId}:${expert.id}`,
          content: prompt,
          expertId: expert.id,
          parentRunId,
          delegationDepth: currentDepth + 1,
        });
      } catch (err) {
        // Emit delegation_end to match the delegation_start above
        if (!ctx.webContents.isDestroyed()) {
          ctx.webContents.send(channel, {
            type: 'delegation_end',
            parentRunId,
            childRunId: '',
            status: 'error',
          } as RendererAgentEvent);
        }
        return textResult(
          `Failed to start expert "${expert.name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Wait for completion
      try {
        const result = await ctx.agentRuntime.waitForCompletion(childRunId, 120_000);

        // Emit delegation_end
        if (!ctx.webContents.isDestroyed()) {
          ctx.webContents.send(channel, {
            type: 'delegation_end',
            parentRunId,
            childRunId,
            status: result.status,
          } as RendererAgentEvent);
        }

        if (result.status === 'error') {
          return textResult(
            `Expert "${expert.name}" encountered an error: ${result.error || 'Unknown error'}. ` +
            `You may want to try again or handle the task directly.`,
          );
        }

        return textResult(
          `[Response from ${expert.name}]\n\n${result.messageContent}`,
        );
      } catch (err) {
        // Emit delegation_end with error status
        if (!ctx.webContents.isDestroyed()) {
          ctx.webContents.send(channel, {
            type: 'delegation_end',
            parentRunId,
            childRunId,
            status: 'error',
          } as RendererAgentEvent);
        }

        return textResult(
          `Delegation to "${expert.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

export function createListExperts(ctx: ToolContext): AgentTool {
  return {
    name: 'list_experts',
    description:
      'List available experts with their IDs, domains, and descriptions. ' +
      'Use this when you need to find the right expert for a task, or when the expert catalog in your system prompt is truncated.',
    label: 'List Experts',
    parameters: Type.Object({
      type: Type.Optional(
        Type.Union([Type.Literal('expert'), Type.Literal('team')], {
          description: 'Filter by expert type. Omit to show all.',
        }),
      ),
      search: Type.Optional(
        Type.String({
          description: 'Search term to filter experts by name or description',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      let url = '/experts?is_enabled=true&limit=50';
      if (params.type) {
        url += `&type=${encodeURIComponent(params.type)}`;
      }

      let experts: ExpertRecord[];
      try {
        const res = await backendRequest<ExpertListResponse>(
          ctx.backendPort,
          'GET',
          url,
        );
        experts = res.experts;
      } catch (err) {
        return textResult(
          `Failed to fetch experts: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Client-side search filter
      if (params.search) {
        const search = params.search.toLowerCase();
        experts = experts.filter(
          (e) =>
            e.name.toLowerCase().includes(search) ||
            e.description.toLowerCase().includes(search) ||
            (e.domain && e.domain.toLowerCase().includes(search)) ||
            isSimilarName(e.name, params.search!),
        );
      }

      if (experts.length === 0) {
        const qualifier = params.search ? ` matching "${params.search}"` : '';
        return textResult(
          `No enabled experts found${qualifier}. You can propose creating one with \`propose_expert\`.`,
        );
      }

      const lines = experts.map((e) => {
        const detail = e.domain ? ` (domain: ${e.domain})` : e.type === 'team' ? ' (team)' : '';
        return `- **${e.name}** [ID: ${e.id}]${detail}: ${e.description}`;
      });

      return textResult(
        `Found ${experts.length} expert(s):\n\n${lines.join('\n')}`,
      );
    },
  };
}

// ── Team orchestration helpers ───────────────────────────────────

function emitTeamEvent(ctx: ToolContext, event: RendererAgentEvent): void {
  if (ctx.webContents && !ctx.webContents.isDestroyed() && ctx.parentRunId) {
    ctx.webContents.send(`agent:event:${ctx.parentRunId}`, event);
  }
}

/**
 * POST to backend SSE endpoint, collect all text_delta events into a string.
 * Used for coordinator operations: strategy selection and result synthesis.
 */
async function singleShotInference(prompt: string, backendPort: number, timeoutMs = 60_000): Promise<string> {
  // Determine which endpoint to use
  let endpoint = '/cloud/chat';
  try {
    const status = await backendRequest<{ state: string }>(backendPort, 'GET', '/models/status');
    if (status.state === 'ready') {
      endpoint = '/models/chat';
    }
  } catch {
    // Fallback to cloud
  }

  const body = JSON.stringify({
    messages: [{ role: 'user', content: prompt }],
    stream: true,
  });

  return new Promise<string>((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: backendPort,
        path: endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString(),
          Accept: 'text/event-stream',
        },
        timeout: timeoutMs,
      },
      (res) => {
        // Check for HTTP errors — fail fast instead of silently returning empty
        if (res.statusCode && res.statusCode >= 400) {
          res.resume(); // drain the response
          reject(new Error(`Inference request failed with status ${res.statusCode}`));
          return;
        }

        let accumulated = '';
        let buffer = '';

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
              const event = JSON.parse(data);
              if (event.type === 'text_delta' && event.delta) {
                accumulated += event.delta;
              }
            } catch { /* skip malformed SSE frames */ }
          }
        });

        res.on('end', () => resolve(accumulated));
        res.on('error', reject);
      },
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Single-shot inference timed out'));
    });
    req.write(body);
    req.end();
  });
}

function selectStrategySmall(team: TeamExpertRecord, task: string): 'sequential' | 'parallel' {
  const taskLower = task.toLowerCase();
  const parallelKeywords = [
    'simultaneously', 'at the same time', 'in parallel', 'independently',
    'each', 'all of', 'compare', 'different perspectives', 'multiple angles',
  ];
  const sequentialKeywords = [
    'then', 'after that', 'next', 'step by step', 'pipeline', 'chain', 'build on',
    'review', 'revise', 'edit', 'improve', 'refine', 'check',
    'draft', 'polish', 'critique', 'feedback', 'finally',
  ];

  let parallelScore = 0;
  let sequentialScore = 0;

  for (const kw of parallelKeywords) {
    if (taskLower.includes(kw)) parallelScore++;
  }
  for (const kw of sequentialKeywords) {
    if (taskLower.includes(kw)) sequentialScore++;
  }

  // Check member roles — if they share the same role, likely parallel
  const members = team.team_members ?? [];
  const roles = new Set(members.map((m) => m.role.toLowerCase()));
  if (roles.size === 1 && members.length > 1) parallelScore += 2;

  // Pipeline-style roles (reviewer, editor, critic, qa) suggest sequential
  const pipelineRoles = ['reviewer', 'editor', 'critic', 'qa', 'proofreader', 'checker'];
  if (members.some((m) => pipelineRoles.includes(m.role.toLowerCase()))) {
    sequentialScore += 2;
  }

  // Default to parallel when ambiguous — produces independent results safely
  return sequentialScore > parallelScore ? 'sequential' : 'parallel';
}

async function selectStrategyMedium(
  task: string,
  memberNames: string[],
  backendPort: number,
): Promise<'sequential' | 'parallel'> {
  const prompt = `You are a task routing assistant. Given a task and team members, decide the execution strategy.

Task: ${task}
Team members: ${memberNames.join(', ')}

Respond with exactly one word: "sequential" or "parallel".
- Use "sequential" when later members need earlier members' output.
- Use "parallel" when members can work independently.`;

  try {
    const result = (await singleShotInference(prompt, backendPort)).trim().toLowerCase();
    if (result.includes('parallel')) return 'parallel';
    return 'sequential';
  } catch {
    return 'sequential';
  }
}

async function selectStrategy(
  tier: ModelTier,
  team: TeamExpertRecord,
  task: string,
  override: string | undefined,
  backendPort: number,
): Promise<'sequential' | 'parallel'> {
  // Explicit override from team config
  if (team.strategy && team.strategy !== 'auto') {
    return team.strategy as 'sequential' | 'parallel';
  }

  // Explicit override from tool call
  if (override && override !== 'auto') {
    return override as 'sequential' | 'parallel';
  }

  const members = team.team_members ?? [];
  const memberNames = members.map((m) => m.name ?? m.role);

  if (tier === 'small') {
    return selectStrategySmall(team, task);
  }

  // Medium and large: use LLM-based selection
  return selectStrategyMedium(task, memberNames, backendPort);
}

function distillContext(previousContext: string, memberRole: string, memberResponse: string, tier: ModelTier): string {
  const maxLen = tier === 'small' ? 500 : tier === 'medium' ? 1500 : 3000;

  let trimmed: string;
  if (memberResponse.length <= maxLen) {
    trimmed = memberResponse;
  } else if (tier === 'small') {
    // Small: hard truncate at sentence boundary
    const cutPoint = memberResponse.lastIndexOf('. ', maxLen);
    trimmed = (cutPoint > maxLen * 0.5 ? memberResponse.slice(0, cutPoint + 1) : memberResponse.slice(0, maxLen)) + '\n...(truncated)';
  } else {
    // Medium/large: keep beginning + end for context continuity
    const headLen = Math.floor(maxLen * 0.7);
    const tailLen = maxLen - headLen;
    const headEnd = memberResponse.lastIndexOf('. ', headLen);
    const head = headEnd > headLen * 0.5 ? memberResponse.slice(0, headEnd + 1) : memberResponse.slice(0, headLen);
    const tail = memberResponse.slice(-tailLen);
    trimmed = `${head}\n\n...(middle omitted)...\n\n${tail}`;
  }

  return `${previousContext}\n\n[${memberRole} output]:\n${trimmed}`.trim();
}

async function synthesizeResults(
  tier: ModelTier,
  team: TeamExpertRecord,
  task: string,
  memberResults: MemberResult[],
  playbook: string | null,
  backendPort: number,
): Promise<string> {
  const successResults = memberResults.filter((r) => r.status === 'completed');
  const failedResults = memberResults.filter((r) => r.status === 'error');

  if (successResults.length === 0) {
    return `All ${memberResults.length} team member(s) failed. Errors:\n` +
      failedResults.map((r) => `- ${r.memberName} (${r.role}): ${r.error ?? 'Unknown error'}`).join('\n');
  }

  // For small models or single successful result, use template merge (no LLM call)
  if (tier === 'small' || successResults.length === 1) {
    let result = successResults.map((r) => `## ${r.memberName} (${r.role})\n${r.content}`).join('\n\n');
    if (failedResults.length > 0) {
      result += `\n\n**Note:** ${failedResults.length} member(s) encountered errors: ` +
        failedResults.map((r) => r.memberName).join(', ');
    }
    return result;
  }

  // Truncate member outputs proportionally so we don't blow token budgets
  const maxPerMember = tier === 'medium' ? 1500 : 3000;
  const memberOutputs = successResults
    .map((r) => `### ${r.memberName} (${r.role})\n${r.content.slice(0, maxPerMember)}`)
    .join('\n\n');

  let playbookSection = '';
  if (playbook) {
    playbookSection = `\n\nTeam playbook:\n${playbook.slice(0, 500)}`;
  }

  let coordinatorSection = '';
  if (team.coordinator_prompt) {
    coordinatorSection = `\n\nCoordinator instructions: ${team.coordinator_prompt}`;
  }

  const failedNote = failedResults.length > 0
    ? `\nNote: ${failedResults.length} member(s) failed: ${failedResults.map((r) => r.memberName).join(', ')}\n`
    : '';

  // Tier-specific synthesis prompts
  let prompt: string;
  if (tier === 'large') {
    prompt = `You are synthesizing responses from a team of experts called "${team.name}".

Task: "${task}"${playbookSection}${coordinatorSection}

${memberOutputs}
${failedNote}
Produce a single, coherent response that:
1. Integrates all expert perspectives into a unified answer
2. Resolves contradictions by noting where experts disagree and why
3. Attributes key insights when the source matters
4. Maintains the depth and nuance of individual contributions

Do NOT simply concatenate — write a response that reads as if one exceptionally knowledgeable person answered.`;
  } else {
    // Medium: structured merge with clear sections
    prompt = `Combine these expert responses into one answer.

Task: "${task}"${playbookSection}${coordinatorSection}

${memberOutputs}
${failedNote}
Format your response as:
## Key Findings
(merged insights from all experts)

## Details
(organized by topic, attributed to experts where relevant)

## Recommendations
(actionable next steps)`;
  }

  try {
    return await singleShotInference(prompt, backendPort);
  } catch {
    // Fallback to concatenation if synthesis inference fails
    return successResults.map((r) => `## ${r.memberName} (${r.role})\n${r.content}`).join('\n\n');
  }
}

async function executeMember(
  ctx: ToolContext,
  member: TeamMemberRecord,
  task: string,
  chainedContext: string,
  userContext?: string,
): Promise<MemberResult> {
  const memberName = member.name ?? member.role;

  if (!ctx.agentRuntime || !ctx.webContents) {
    return { memberId: member.expert_id, memberName, role: member.role, status: 'error', content: '', error: 'No runtime' };
  }

  // Compose prompt — support {task} and {context} placeholders in delegation_prompt
  let prompt: string;
  if (member.delegation_prompt) {
    prompt = member.delegation_prompt
      .replaceAll('{task}', task)
      .replaceAll('{context}', userContext ?? '');
  } else {
    prompt = task;
  }
  if (userContext && !member.delegation_prompt) {
    prompt += `\n\nAdditional context:\n${userContext}`;
  }
  if (chainedContext) {
    prompt += `\n\nContext from previous team members:\n${chainedContext}`;
  }

  const parentRunId = ctx.parentRunId!;
  const currentDepth = ctx.delegationDepth ?? 0;

  let childRunId: string;
  try {
    childRunId = await ctx.agentRuntime.startRun(ctx.webContents, {
      conversationId: `team:${parentRunId}:${member.expert_id}`,
      content: prompt,
      expertId: member.expert_id,
      parentRunId,
      delegationDepth: currentDepth + 1,
    });
  } catch (err) {
    return {
      memberId: member.expert_id,
      memberName,
      role: member.role,
      status: 'error',
      content: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const result: SubAgentResult = await ctx.agentRuntime.waitForCompletion(childRunId, 120_000);
    return {
      memberId: member.expert_id,
      memberName,
      role: member.role,
      status: result.status === 'completed' ? 'completed' : 'error',
      content: result.messageContent,
      error: result.error,
    };
  } catch (err) {
    return {
      memberId: member.expert_id,
      memberName,
      role: member.role,
      status: 'error',
      content: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function executeSequential(
  ctx: ToolContext,
  team: TeamExpertRecord,
  task: string,
  tier: ModelTier,
  userContext?: string,
): Promise<MemberResult[]> {
  const members = (team.team_members ?? []).sort((a, b) => a.order - b.order);
  const results: MemberResult[] = [];
  let chainedContext = '';

  for (const member of members) {
    const memberName = member.name ?? member.role;

    emitTeamEvent(ctx, {
      type: 'member_started',
      teamId: team.id,
      memberId: member.expert_id,
      memberName,
    });

    const result = await executeMember(ctx, member, task, chainedContext, userContext);
    results.push(result);

    emitTeamEvent(ctx, {
      type: 'member_completed',
      teamId: team.id,
      memberId: member.expert_id,
      memberName,
      status: result.status,
      response: result.content || undefined,
    });

    if (result.status === 'completed') {
      chainedContext = distillContext(chainedContext, member.role, result.content, tier);
    } else if (member.on_error === 'fail') {
      break; // Abort the pipeline — remaining members won't run
    }
    // on_error === 'skip' (default): continue to next member
  }

  return results;
}

async function executeParallel(
  ctx: ToolContext,
  team: TeamExpertRecord,
  task: string,
  userContext?: string,
): Promise<MemberResult[]> {
  const members = (team.team_members ?? []).sort((a, b) => a.order - b.order);

  // Emit member_started for all
  for (const member of members) {
    const memberName = member.name ?? member.role;
    emitTeamEvent(ctx, {
      type: 'member_started',
      teamId: team.id,
      memberId: member.expert_id,
      memberName,
    });
  }

  // Fan out
  const promises = members.map(async (member) => {
    const result = await executeMember(ctx, member, task, '', userContext);
    const memberName = member.name ?? member.role;

    emitTeamEvent(ctx, {
      type: 'member_completed',
      teamId: team.id,
      memberId: member.expert_id,
      memberName,
      status: result.status,
      response: result.content || undefined,
    });

    // If this member has on_error='fail' and it errored, abort the team
    if (result.status === 'error' && member.on_error === 'fail') {
      throw new Error(`Critical member "${memberName}" failed: ${result.error ?? 'Unknown error'}`);
    }

    return result;
  });

  return Promise.all(promises);
}

// ── delegate_to_team tool ────────────────────────────────────────

export function createDelegateToTeam(ctx: ToolContext): AgentTool {
  return {
    name: 'delegate_to_team',
    description:
      'Delegate a task to a team of experts. The team will execute using its configured strategy ' +
      '(sequential with context chaining, or parallel fan-out), then synthesize results. ' +
      'Use this for tasks that benefit from multiple expert perspectives or a pipeline of specialists.',
    label: 'Delegate to Team',
    parameters: Type.Object({
      team_id: Type.String({
        description: 'The team ID (from the [ID: xxx] in the expert catalog)',
      }),
      task: Type.String({
        description:
          'Clear, complete description of what the team should accomplish. Include all relevant context.',
      }),
      context: Type.Optional(
        Type.String({
          description:
            'Additional context from the conversation that team members need. ' +
            'Include user preferences, constraints, or prior information.',
        }),
      ),
      strategy_override: Type.Optional(
        Type.Union([Type.Literal('sequential'), Type.Literal('parallel'), Type.Literal('auto')], {
          description: 'Override the team\'s default strategy. Omit to use the team\'s configured strategy.',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      if (!ctx.agentRuntime || !ctx.webContents) {
        return textResult('Team delegation is not available in this context.');
      }

      // Depth check: team delegation uses depth+1 for member runs
      const currentDepth = ctx.delegationDepth ?? 0;
      if (currentDepth + 2 > MAX_DELEGATION_DEPTH) {
        return textResult(
          `Delegation depth limit would be exceeded. Handle this task directly instead of delegating to a team.`,
        );
      }

      // Load team
      let team: TeamExpertRecord;
      try {
        team = await backendRequest<TeamExpertRecord>(
          ctx.backendPort,
          'GET',
          `/experts/${params.team_id}`,
        );
      } catch {
        return textResult(
          `Team with ID "${params.team_id}" not found. Use \`list_experts\` to see available teams.`,
        );
      }

      if (team.type !== 'team') {
        return textResult(
          `"${team.name}" is not a team — it's an individual expert. Use \`delegate_to_expert\` instead.`,
        );
      }

      if (!team.is_enabled) {
        return textResult(`Team "${team.name}" is currently disabled.`);
      }

      const members = team.team_members ?? [];
      if (members.length === 0) {
        return textResult(`Team "${team.name}" has no members configured.`);
      }

      // Resolve member names by fetching each expert
      for (const member of members) {
        try {
          const expert = await backendRequest<ExpertRecord>(
            ctx.backendPort,
            'GET',
            `/experts/${member.expert_id}`,
          );
          member.name = expert.name;
        } catch {
          member.name = member.role;
        }
      }

      // Load playbook (non-critical)
      let playbook: string | null = null;
      try {
        const playbookRes = await backendRequest<{ content: string }>(
          ctx.backendPort,
          'GET',
          `/memory/context-files/team:${params.team_id}`,
        );
        playbook = playbookRes.content ?? null;
      } catch {
        // No playbook configured
      }

      // Resolve model tier
      const resolvedModel = await resolveModel(null, ctx.backendPort);
      const tier: ModelTier = resolvedModel ? classifyModelTier(resolvedModel) : 'medium';

      // Select strategy
      const strategy = await selectStrategy(tier, team, params.task, params.strategy_override, ctx.backendPort);

      // Emit team_started
      emitTeamEvent(ctx, {
        type: 'team_started',
        teamId: team.id,
        teamName: team.name,
        strategy,
        memberCount: members.length,
      });

      // Queue all members
      for (const member of members) {
        emitTeamEvent(ctx, {
          type: 'member_queued',
          teamId: team.id,
          memberId: member.expert_id,
          memberName: member.name ?? member.role,
          role: member.role,
        });
      }

      // Execute
      let results: MemberResult[];
      try {
        if (strategy === 'parallel') {
          results = await executeParallel(ctx, team, params.task, params.context);
        } else {
          results = await executeSequential(ctx, team, params.task, tier, params.context);
        }
      } catch (err) {
        // on_error='fail' in parallel can throw — abort the team
        emitTeamEvent(ctx, {
          type: 'team_completed',
          teamId: team.id,
          status: 'error',
          successCount: 0,
          totalCount: members.length,
        });
        return textResult(
          `Team "${team.name}" aborted: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const successCount = results.filter((r) => r.status === 'completed').length;

      // Total failure — all members failed
      if (successCount === 0) {
        emitTeamEvent(ctx, {
          type: 'team_completed',
          teamId: team.id,
          status: 'error',
          successCount: 0,
          totalCount: results.length,
        });

        const errors = results
          .filter((r) => r.status === 'error')
          .map((r) => `- ${r.memberName}: ${r.error ?? 'Unknown error'}`)
          .join('\n');
        return textResult(
          `All members of team "${team.name}" failed.\n\nErrors:\n${errors}`,
        );
      }

      // Partial failure — proceed with synthesis, but note the gaps
      // (tech design: warn but still synthesize from successful members)

      // Synthesize
      emitTeamEvent(ctx, { type: 'team_synthesis', teamId: team.id });
      const synthesized = await synthesizeResults(tier, team, params.task, results, playbook, ctx.backendPort);

      // Emit team_completed
      emitTeamEvent(ctx, {
        type: 'team_completed',
        teamId: team.id,
        status: 'completed',
        successCount,
        totalCount: results.length,
      });

      return textResult(`[Team Response from ${team.name}]\n\n${synthesized}`);
    },
  };
}
