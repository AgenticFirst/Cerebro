# Team Orchestration

## Problem Statement

Core Intelligence (Phase 3) gave Cerebro the ability to route tasks to individual experts and propose new ones through conversation. A user can ask "help me plan a marathon" and Cerebro delegates to a Fitness Coach. This works. But real tasks are rarely single-domain. "Help me launch a product" requires market research, copywriting, technical review, and competitive analysis — four different experts, each building on or responding to the others' work. Today, the user must manually delegate to each expert in sequence, copy-paste context between conversations, and synthesize the results themselves. The infrastructure for multi-expert coordination exists in pieces — delegation tools, concurrent run slots, event streaming — but nothing ties them together into a coordinated team.

Every major framework has attempted this. OpenAI's Agents SDK uses sequential handoffs — one agent passes control to the next. Anthropic's research on orchestrator-worker patterns showed 90.2% improvement over single-agent approaches but at 15x token cost with cloud models only. Google ADK offers `SequentialAgent`, `ParallelAgent`, and `LoopAgent` primitives with an `AutoFlow` LLM router. CrewAI and AutoGen provide YAML/code-configured agent teams. All of them share the same limitations:

1. **Cloud-only.** No framework offers team orchestration with local models. When the API key is missing or the network is down, teams don't work.
2. **Fixed strategies.** Teams are configured as sequential OR parallel at definition time. The same team can't adapt its execution strategy based on the specific task.
3. **No tier awareness.** A 4B parameter model gets the same coordination prompts as GPT-4 or Claude Opus. Small models choke on free-form routing decisions that large models handle effortlessly.
4. **Configuration-heavy.** Teams require YAML files, Python class definitions, or JSON schemas. No framework lets users create teams through conversation.

Team Orchestration makes Cerebro the first agent framework that coordinates expert teams across the full model spectrum — from a 4B local model running offline to Claude Opus in the cloud — with strategy selection that adapts to both the task and the model's capability tier.

## Design Principles

1. **Task-adaptive strategy.** The system analyzes each incoming task and chooses the best execution strategy (parallel, sequential, or hybrid) at runtime. A content creation team might run sequentially for "write a blog post" (research → draft → edit) but in parallel for "generate three different headlines." Strategy is a property of the task, not the team.

2. **Tier-adaptive coordination.** The same team behaves differently on a 4B local model versus Claude Opus. Large models get autonomous coordination with full reasoning freedom. Small models get structured templates that produce reliable results without requiring the model to make complex routing decisions. The user never configures this — tier detection is automatic.

3. **Progressive streaming.** Users see results as each expert completes, not silence followed by a wall of text. The UI shows which expert is active, which are queued, and surfaces each member's contribution as it arrives.

4. **Conversational team creation.** Teams are proposed through natural conversation — "I need a team for content creation" — using the same propose-preview-save pattern proven with expert proposals. No YAML, no config files, no code.

5. **Memory-aware collaboration.** Teams accumulate a playbook — patterns that worked, strategies that failed, coordination preferences — and improve over time. No competitor offers team-level memory.

6. **Graceful degradation over graceless failure.** When a team member fails, the coordinator synthesizes from the remaining members rather than aborting. When the model tier can't support hybrid orchestration, the system falls back to sequential. When only one model is available locally, parallel becomes serialized-with-progress rather than erroring out.

## Architecture Overview

```
User: "Help me launch my product"
       |
       v
ChatContext.sendMessage()
       | (IPC)
       v
AgentRuntime.startRun() — Cerebro mode (personal scope)
       |
       v
LLM sees "Launch Team [ID: xyz] (team, 4 members)" in expert catalog
       |
       v
LLM calls delegate_to_team(teamId="xyz", task="...")
       |
       v
delegate_to_team tool:
       |
       +-- 1. Load team definition (GET /experts/{teamId})
       |
       +-- 2. Select strategy:
       |       Large model  → LLM-powered task analysis (auto)
       |       Medium model → Structured decision template
       |       Small model  → Heuristic from team config + task keywords
       |
       +-- 3. Execute strategy:
       |       |
       |       +-- PARALLEL: Promise.all(members.map(delegate))
       |       |     Cloud: true concurrent HTTP requests
       |       |     Local: serialized at inference lock, progress events stream
       |       |
       |       +-- SEQUENTIAL: for-of loop with context chaining
       |       |     Each member receives original task + accumulated results
       |       |     Context distilled between steps to fit token budgets
       |       |
       |       +-- HYBRID (large models only): coordinator decomposes into phases
       |             Some phases parallel, others sequential
       |             Falls back to sequential on medium/small tiers
       |
       +-- 4. Synthesize results:
       |       Large:  free-form synthesis — coordinator writes cohesive response
       |       Medium: structured merge with attribution
       |       Small:  template-based merge with labeled slots
       |
       +-- 5. Return synthesized response as tool result
       |
       v
Cerebro presents synthesized response to user
```

The coordinator is NOT a separate agent type. When Cerebro calls `delegate_to_team`, the tool itself handles all coordination logic — strategy selection, member delegation, and synthesis. This reuses the existing agent loop, delegation infrastructure, and event system without introducing a new agent primitive. The coordination intelligence lives in the tool implementation and in tier-specific synthesis prompts, not in a separate orchestrator agent that consumes its own turn budget.

### Why Agent-as-Tool, Not a DAG

The DAG executor (`src/engine/engine.ts`) runs static, predetermined workflows — step A feeds step B feeds step C, compiled once, same every time. Teams need the opposite: dynamic coordination where the next step depends on what the previous expert produced. The coordinator might skip a member whose expertise isn't needed, re-run a member with refined context, or switch from parallel to sequential mid-execution based on intermediate results. Agent-as-tool gives us this flexibility because the coordination logic is imperative code responding to real results, not a pre-compiled graph.

## Dynamic Strategy Selection

This is the core innovation. Every other framework forces teams into a fixed strategy at definition time. Cerebro selects the strategy at task time, and the selection mechanism adapts to the model tier.

### Large Models (Cloud)

LLM-powered task analysis. The coordinator examines the task and the team roster, then decides the optimal strategy. This happens as a single inference call before any member delegation begins.

```typescript
const STRATEGY_ANALYSIS_PROMPT = `You are analyzing a task to determine the best execution strategy for a team.

Team: {teamName}
Members:
{memberList}

Task: "{task}"

Analyze the task and respond with EXACTLY this JSON:
{
  "strategy": "parallel" | "sequential",
  "reasoning": "one sentence explaining why",
  "member_order": ["member_id_1", "member_id_2", ...],
  "skip_members": ["member_id_to_skip", ...],
  "phase_plan": "optional: for sequential, describe what each member should focus on"
}

Decision guide:
- PARALLEL when members can work independently (different angles on same topic, independent subtasks)
- SEQUENTIAL when later members need earlier members' output (research→write, draft→review, plan→execute)
- Skip members whose expertise is clearly irrelevant to this specific task

Respond with JSON only, no explanation.`;
```

The coordinator can also produce a hybrid plan — but only on large models. Hybrid means the task is decomposed into phases, where some phases are parallel and others sequential:

```typescript
// Hybrid example: "Launch my product" with a 4-member team
// Phase 1 (parallel): Market Researcher + Competitive Analyst work simultaneously
// Phase 2 (sequential): Copywriter uses Phase 1 results to draft messaging
// Phase 3 (sequential): Technical Reviewer validates claims against product specs
```

Hybrid is powerful but requires strong multi-step reasoning. It is gated to large models only.

### Medium Models (12–35B)

Structured decision template. The model fills in a constrained classification rather than free-form reasoning:

```typescript
const STRATEGY_TEMPLATE_MEDIUM = `Task: "{task}"
Team members: {memberNames}

Question: Can all team members work on this task independently, or does each member need the previous member's output?

Answer ONE word: PARALLEL or SEQUENTIAL

Answer:`;
```

Medium models reliably classify tasks into one of two categories. They don't get hybrid mode — the reasoning required to decompose a task into parallel and sequential phases exceeds what 12–35B models do reliably. But they CAN make the binary parallel/sequential decision accurately, and they can optionally skip members by answering a follow-up:

```typescript
const MEMBER_FILTER_TEMPLATE = `Task: "{task}"
Team members:
{memberListWithDescriptions}

Which members are NOT needed for this task? List their IDs, or write NONE.

Answer:`;
```

### Small Models (1–8B)

No LLM-based strategy selection. Small models produce unreliable JSON, hallucinate member IDs, and make inconsistent routing decisions. Instead, strategy is determined by a deterministic heuristic:

```typescript
function selectStrategySmall(
  team: TeamDefinition,
  task: string,
): 'parallel' | 'sequential' {
  // 1. Explicit strategy on team definition wins
  if (team.strategy && team.strategy !== 'auto') {
    return team.strategy;
  }

  // 2. Keyword heuristic: sequential indicators
  const sequentialKeywords = [
    'review', 'revise', 'edit', 'improve', 'refine', 'check',
    'then', 'after', 'next', 'finally', 'step by step',
    'draft', 'polish', 'critique', 'feedback',
  ];
  const taskLower = task.toLowerCase();
  const hasSequentialSignal = sequentialKeywords.some((kw) => taskLower.includes(kw));

  // 3. Member roles heuristic: ordered roles suggest pipeline
  const roleOrder = team.members.some((m) =>
    ['reviewer', 'editor', 'critic', 'qa'].includes(m.role.toLowerCase()),
  );

  if (hasSequentialSignal || roleOrder) return 'sequential';

  // 4. Default to parallel (safe: produces independent results)
  return 'parallel';
}
```

This isn't "dumbed down" — it's strategically constrained. Small models excel at focused, single-task execution. They don't need to make routing decisions if the routing is handled by deterministic logic that's been tuned for common patterns. The quality of each member's individual response is where small models shine, and that's preserved fully.

### Strategy Selection Summary

| Tier | Method | Strategies Available | Member Filtering |
|------|--------|---------------------|-----------------|
| Large (cloud) | LLM task analysis | Parallel, Sequential, Hybrid | LLM decides which members to involve |
| Medium (12–35B) | Structured template | Parallel, Sequential | Template-based skip list |
| Small (1–8B) | Deterministic heuristic | Parallel, Sequential | All members participate |

## Data Model Extensions

### Team Schema

The existing `Expert` model already supports teams via `type='team'` and `team_members` JSON. Two new fields are added to the `TeamMember` schema and two to the team-level `Expert`:

```python
# backend/experts/schemas.py

class TeamMember(BaseModel):
    expert_id: str
    role: str
    order: int = 0
    delegation_prompt: str | None = None  # NEW: per-member task template
    on_error: str = "skip"                # NEW: "skip" | "retry" | "fail"


# Additional fields on ExpertCreate/ExpertUpdate (only meaningful when type="team"):
class ExpertCreate(BaseModel):
    # ... existing fields ...
    strategy: str | None = None           # NEW: "auto" | "sequential" | "parallel" (default: "auto")
    coordinator_prompt: str | None = None  # NEW: instructions for task decomposition
```

```python
# backend/models.py — add to Expert model

strategy: Mapped[str | None] = mapped_column(String(20), nullable=True)          # auto | sequential | parallel
coordinator_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)       # team coordination instructions
```

**`delegation_prompt`**: An optional template that customizes the task sent to this specific member. Supports `{task}` and `{context}` placeholders. Example: `"Analyze the following from a market research perspective. Focus on competitive positioning and market size. Task: {task}"`. When absent, the member receives the raw task.

**`on_error`**: What happens when this member fails. `skip` means continue without this member's contribution (default — most resilient). `retry` means attempt once more. `fail` means abort the entire team run.

**`strategy`**: Team-level strategy preference. `auto` (default) enables dynamic strategy selection. `sequential` or `parallel` forces that strategy regardless of task analysis. Useful for teams with a known fixed workflow.

**`coordinator_prompt`**: Free-text instructions for how the coordinator should decompose and synthesize tasks for this team. Injected into the strategy analysis and synthesis prompts. Example: `"This team follows a research-draft-review pipeline. The researcher always goes first, the writer uses research output, and the editor reviews the final draft."`.

### Team Memory

Each team gets a playbook context file stored in the `settings` table with key `memory:context:team:{id}`. This is the same storage mechanism used for expert context files (`memory:context:expert:{id}`) — no new tables or storage systems needed.

```python
# Playbook key format
playbook_key = f"memory:context:team:{team_id}"

# Stored in settings table as markdown:
# ## Content Team Playbook
#
# ### What Works
# - Sequential strategy produces better blog posts than parallel
# - The editor catches more issues when they see the full draft, not a summary
#
# ### Coordination Notes
# - Researcher should focus on data, not opinions
# - Writer prefers bullet-point briefs over full paragraphs from researcher
```

The playbook is fetched during `delegate_to_team` execution and injected into synthesis prompts. After a team run completes, the memory extraction system (`POST /memory/extract`) can capture team-level facts with `scope='team'` and `scope_id=teamId`.

## Coordinator Design

The coordinator is not a separate agent. It is the `delegate_to_team` tool implementation itself, augmented by tier-specific prompts for strategy selection and synthesis. No new agent type, no new runtime, no new loop — just a tool that makes multiple `delegate_to_expert` calls and synthesizes the results.

### Strategy Selection Prompts

Three tier-specific prompts for the strategy analysis phase:

**Large (cloud) — full autonomy:**
```
You are coordinating a team of experts to handle the following task.

Team: {teamName}
{coordinatorPrompt}

Members:
{memberListWithDescriptions}

Task: "{task}"

Decide the execution strategy:
- PARALLEL: Members work independently on the same task (different perspectives, independent subtasks)
- SEQUENTIAL: Members work in order, each building on previous output (research→write, draft→review)
- HYBRID: Decompose into phases — some parallel, some sequential

Respond with JSON:
{
  "strategy": "parallel" | "sequential" | "hybrid",
  "reasoning": "brief explanation",
  "phases": [
    { "type": "parallel" | "sequential", "members": ["id1", "id2"], "focus": "what this phase does" }
  ]
}
```

**Medium (12–35B) — binary classification:**
```
Task: "{task}"
Team: {memberNames}
{coordinatorPrompt}

Can all members work on this independently? Answer PARALLEL or SEQUENTIAL.
Answer:
```

**Small (1–8B) — no prompt needed.** Strategy selection is pure code (the `selectStrategySmall` heuristic).

### Synthesis Prompts

After all members have contributed, the coordinator synthesizes their results into a single response. Synthesis prompts are also tier-specific:

**Large — free-form synthesis:**
```
You are synthesizing responses from a team of experts.

Task: "{task}"

{memberResults}

Produce a single, coherent response that:
1. Integrates all expert perspectives into a unified answer
2. Resolves contradictions by noting where experts disagree and why
3. Attributes key insights when the source matters
4. Maintains the depth and nuance of individual contributions

Do NOT simply concatenate — write a response that reads as if one exceptionally knowledgeable person answered.
```

**Medium — structured merge:**
```
Combine these expert responses into one answer.

Task: "{task}"

{memberResults}

Format your response as:
## Key Findings
(merged insights from all experts)

## Details
(organized by topic, attributed to experts where relevant)

## Recommendations
(actionable next steps)
```

**Small — template merge:**
```
Merge these expert answers into one response. Keep it concise.

Task: "{task}"

{memberResults}

Write your merged response below. Include the most important points from each expert.
Response:
```

The small model synthesis is intentionally simple. Complex synthesis instructions cause small models to hallucinate structure or lose content. A minimal prompt produces the best results by letting the model focus on content merging rather than format compliance.

## The `delegate_to_team` Tool

### Tool Definition

```typescript
// src/agents/tools/delegation-tools.ts

export function createDelegateToTeam(ctx: ToolContext): AgentTool {
  return {
    name: 'delegate_to_team',
    description:
      'Delegate a task to a team of experts who collaborate to produce a combined response. ' +
      'The team will automatically choose the best execution strategy (parallel or sequential) ' +
      'based on the task. Provide a clear, complete task description.',
    label: 'Delegate to Team',
    parameters: Type.Object({
      team_id: Type.String({
        description: 'The team ID (from the [ID: xxx] in the expert catalog)',
      }),
      task: Type.String({
        description:
          'Clear, complete description of what the team should accomplish. ' +
          'Include all relevant context since team members cannot see chat history.',
      }),
      context: Type.Optional(
        Type.String({
          description: 'Additional context from the conversation that team members need.',
        }),
      ),
      strategy: Type.Optional(
        Type.Union(
          [Type.Literal('parallel'), Type.Literal('sequential')],
          {
            description:
              'Force a specific strategy. Omit to let the system choose automatically.',
          },
        ),
      ),
    }),
    execute: async (_toolCallId, params) => {
      // Implementation follows
    },
  };
}
```

### Execution Flow

```typescript
execute: async (_toolCallId, params) => {
  if (!ctx.agentRuntime || !ctx.webContents) {
    return textResult('Team delegation is not available in this context.');
  }

  // Depth check: team counts as 1 level, each member adds 1 more
  const currentDepth = ctx.delegationDepth ?? 0;
  if (currentDepth + 2 > MAX_DELEGATION_DEPTH) {
    return textResult(
      `Delegation depth limit (${MAX_DELEGATION_DEPTH}) would be exceeded. ` +
      `Handle this task directly.`,
    );
  }

  // 1. Load team definition
  let team: TeamExpertRecord;
  try {
    team = await backendRequest<TeamExpertRecord>(
      ctx.backendPort, 'GET', `/experts/${params.team_id}`,
    );
  } catch {
    return textResult(`Team "${params.team_id}" not found.`);
  }

  if (team.type !== 'team' || !team.team_members?.length) {
    return textResult(`Expert "${team.name}" is not a team or has no members.`);
  }

  // 2. Load team playbook (non-critical)
  let playbook = '';
  try {
    const res = await backendRequest<{ content: string }>(
      ctx.backendPort, 'GET',
      `/memory/context-files/team:${params.team_id}`,
    );
    playbook = res.content || '';
  } catch { /* playbook is optional */ }

  // 3. Resolve model tier
  const resolvedModel = await resolveModel(null, ctx.backendPort);
  const tier = resolvedModel ? classifyModelTier(resolvedModel) : 'small';

  // 4. Select strategy
  const strategy = await selectStrategy(
    tier, team, params.task, params.strategy, playbook, ctx.backendPort,
  );

  // 5. Emit team_started event
  emitTeamEvent(ctx, 'team_started', {
    teamId: team.id, teamName: team.name,
    strategy, memberCount: team.team_members.length,
  });

  // 6. Execute strategy
  let memberResults: MemberResult[];
  try {
    if (strategy === 'parallel') {
      memberResults = await executeParallel(ctx, team, params);
    } else if (strategy === 'hybrid') {
      memberResults = await executeHybrid(ctx, team, params, tier);
    } else {
      memberResults = await executeSequential(ctx, team, params, tier);
    }
  } catch (err) {
    emitTeamEvent(ctx, 'team_completed', {
      teamId: team.id, status: 'error',
    });
    return textResult(
      `Team "${team.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 7. Check for catastrophic failure (>50% members failed)
  const successful = memberResults.filter((r) => r.status === 'completed');
  if (successful.length === 0) {
    emitTeamEvent(ctx, 'team_completed', { teamId: team.id, status: 'error' });
    return textResult(
      `All members of "${team.name}" failed. Consider delegating to individual experts.`,
    );
  }
  if (successful.length < memberResults.length / 2) {
    // Proceed with warning — synthesis will note the gaps
  }

  // 8. Synthesize
  const synthesis = await synthesizeResults(
    tier, team, params.task, memberResults, playbook, ctx.backendPort,
  );

  emitTeamEvent(ctx, 'team_completed', {
    teamId: team.id, status: 'completed',
    successCount: successful.length, totalCount: memberResults.length,
  });

  return textResult(synthesis);
}
```

### Depth Tracking

Team delegation uses depth `currentDepth + 1` for the team coordination level, and each member delegation adds another level (depth `currentDepth + 2`). With `MAX_DELEGATION_DEPTH = 3`, this means:

- Top-level Cerebro (depth 0) → team coordination (depth 1) → member expert (depth 2) ✓
- Nested team delegation (depth 1+) → fails depth check ✓

Teams cannot recursively delegate to other teams. This is by design — nested team delegation creates exponential fan-out that would overwhelm both token budgets and user comprehension.

## Execution Strategies

### Parallel (Fan-Out / Fan-In)

All members receive the task independently and work simultaneously. For cloud models, this means true concurrent HTTP requests. For local models, execution serializes at the inference lock — but the UX remains responsive through progress events.

```typescript
async function executeParallel(
  ctx: ToolContext,
  team: TeamExpertRecord,
  params: { task: string; context?: string },
): Promise<MemberResult[]> {
  const members = team.team_members!;
  const task = params.context
    ? `${params.task}\n\nAdditional context:\n${params.context}`
    : params.task;

  // Emit queued events for all members
  for (const member of members) {
    emitTeamEvent(ctx, 'member_queued', {
      teamId: team.id, memberId: member.expert_id, role: member.role,
    });
  }

  // Fan out — all members start concurrently
  const promises = members.map(async (member) => {
    emitTeamEvent(ctx, 'member_started', {
      teamId: team.id, memberId: member.expert_id,
    });

    const memberTask = member.delegation_prompt
      ? member.delegation_prompt
          .replace('{task}', task)
          .replace('{context}', params.context || '')
      : task;

    try {
      const childRunId = await ctx.agentRuntime!.startRun(ctx.webContents!, {
        conversationId: `team:${ctx.parentRunId}:${member.expert_id}`,
        content: memberTask,
        expertId: member.expert_id,
        parentRunId: ctx.parentRunId,
        delegationDepth: (ctx.delegationDepth ?? 0) + 2,
      });

      const result = await ctx.agentRuntime!.waitForCompletion(childRunId, 180_000);

      emitTeamEvent(ctx, 'member_completed', {
        teamId: team.id, memberId: member.expert_id,
        status: result.status,
      });

      return {
        memberId: member.expert_id,
        role: member.role,
        status: result.status,
        content: result.messageContent,
      } as MemberResult;

    } catch (err) {
      emitTeamEvent(ctx, 'member_completed', {
        teamId: team.id, memberId: member.expert_id, status: 'error',
      });

      if (member.on_error === 'fail') {
        throw err; // Abort entire team
      }

      return {
        memberId: member.expert_id,
        role: member.role,
        status: 'error',
        content: '',
        error: err instanceof Error ? err.message : String(err),
      } as MemberResult;
    }
  });

  return Promise.all(promises);
}
```

**Local model behavior**: `Promise.all` fires all delegation requests at once, but the backend's `asyncio.Lock` in `inference.py` serializes actual inference. This means members execute one-at-a-time, but `member_queued` → `member_started` → `member_completed` events stream to the UI throughout. The user sees real progress, not a frozen spinner. When a cloud provider is active, all members truly run in parallel via concurrent HTTP requests.

**Concurrency limit**: `AgentRuntime.MAX_CONCURRENT_RUNS = 5` caps total active runs. A 4-member team uses 4 of these slots. If the runtime already has 2 active runs, a 4-member team exceeds the limit. The tool checks available slots before starting and falls back to sequential if slots are insufficient:

```typescript
const availableSlots = MAX_CONCURRENT_RUNS - ctx.agentRuntime.getActiveRuns().length;
if (availableSlots < members.length) {
  // Not enough slots for parallel — fall back to sequential
  return executeSequential(ctx, team, params, tier);
}
```

### Sequential (Pipeline)

Members execute in `order`, each receiving the original task plus accumulated context from all previous members. This is the natural fit for workflows with inherent dependencies: research → draft → review → publish.

```typescript
async function executeSequential(
  ctx: ToolContext,
  team: TeamExpertRecord,
  params: { task: string; context?: string },
  tier: ModelTier,
): Promise<MemberResult[]> {
  const members = [...team.team_members!].sort((a, b) => a.order - b.order);
  const results: MemberResult[] = [];
  let accumulatedContext = params.context || '';

  for (const member of members) {
    emitTeamEvent(ctx, 'member_started', {
      teamId: team.id, memberId: member.expert_id,
    });

    // Compose task with accumulated context
    let memberTask = params.task;
    if (accumulatedContext) {
      memberTask = `${params.task}\n\n## Context from Previous Team Members\n${accumulatedContext}`;
    }

    // Apply member-specific delegation prompt if present
    if (member.delegation_prompt) {
      memberTask = member.delegation_prompt
        .replace('{task}', params.task)
        .replace('{context}', accumulatedContext);
    }

    try {
      const childRunId = await ctx.agentRuntime!.startRun(ctx.webContents!, {
        conversationId: `team:${ctx.parentRunId}:${member.expert_id}`,
        content: memberTask,
        expertId: member.expert_id,
        parentRunId: ctx.parentRunId,
        delegationDepth: (ctx.delegationDepth ?? 0) + 2,
      });

      const result = await ctx.agentRuntime!.waitForCompletion(childRunId, 180_000);

      const memberResult: MemberResult = {
        memberId: member.expert_id,
        role: member.role,
        status: result.status,
        content: result.messageContent,
      };
      results.push(memberResult);

      emitTeamEvent(ctx, 'member_completed', {
        teamId: team.id, memberId: member.expert_id, status: result.status,
      });

      // Distill context for next member
      if (result.status === 'completed') {
        accumulatedContext = distillContext(
          accumulatedContext, member.role, result.messageContent, tier,
        );
      }

    } catch (err) {
      emitTeamEvent(ctx, 'member_completed', {
        teamId: team.id, memberId: member.expert_id, status: 'error',
      });

      if (member.on_error === 'fail') throw err;

      if (member.on_error === 'retry') {
        // One retry attempt
        try {
          const retryRunId = await ctx.agentRuntime!.startRun(ctx.webContents!, {
            conversationId: `team:${ctx.parentRunId}:${member.expert_id}:retry`,
            content: memberTask,
            expertId: member.expert_id,
            parentRunId: ctx.parentRunId,
            delegationDepth: (ctx.delegationDepth ?? 0) + 2,
          });
          const retryResult = await ctx.agentRuntime!.waitForCompletion(retryRunId, 180_000);
          results.push({
            memberId: member.expert_id,
            role: member.role,
            status: retryResult.status,
            content: retryResult.messageContent,
          });
          if (retryResult.status === 'completed') {
            accumulatedContext = distillContext(
              accumulatedContext, member.role, retryResult.messageContent, tier,
            );
          }
          continue;
        } catch { /* retry failed, skip */ }
      }

      // on_error: 'skip' — continue without this member
      results.push({
        memberId: member.expert_id,
        role: member.role,
        status: 'error',
        content: '',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
```

### Context Distillation

Between sequential steps, accumulated context must be compressed to fit within token budgets. Raw concatenation would quickly exceed small model context windows. The `distillContext` function produces a focused summary:

```typescript
function distillContext(
  previousContext: string,
  memberRole: string,
  memberResponse: string,
  tier: ModelTier,
): string {
  const tierLimits: Record<ModelTier, number> = {
    small: 800,    // ~200 tokens
    medium: 2000,  // ~500 tokens
    large: 8000,   // ~2000 tokens
  };
  const limit = tierLimits[tier];

  // Build accumulated context
  const newSection = `### ${memberRole}\n${memberResponse}`;
  const combined = previousContext
    ? `${previousContext}\n\n${newSection}`
    : newSection;

  // If within budget, pass through
  if (combined.length <= limit) return combined;

  // Truncate: keep the latest member's full response, compress earlier context
  if (memberResponse.length <= limit * 0.7) {
    const remainingBudget = limit - memberResponse.length - 50;
    const truncatedPrevious = previousContext.slice(0, remainingBudget) + '...(truncated)';
    return `${truncatedPrevious}\n\n${newSection}`;
  }

  // Latest response itself is too long — truncate it
  return `### ${memberRole}\n${memberResponse.slice(0, limit - 50)}...(truncated)`;
}
```

This is intentionally simple. LLM-based summarization between pipeline steps would double the inference cost and add latency. Character-level truncation with smart budget allocation (prioritize latest, truncate earliest) is fast, predictable, and preserves the most relevant context.

### Hybrid (Large Models Only)

The hybrid strategy decomposes a task into phases, some parallel and some sequential. This is the most powerful strategy but requires multi-step reasoning that only large models handle reliably.

```typescript
async function executeHybrid(
  ctx: ToolContext,
  team: TeamExpertRecord,
  params: { task: string; context?: string },
  tier: ModelTier,
): Promise<MemberResult[]> {
  // Hybrid requires a phase plan from the strategy analysis
  // The strategy analysis prompt for large models returns:
  // { strategy: "hybrid", phases: [{ type, members, focus }] }
  //
  // If tier is not 'large', fall back to sequential
  if (tier !== 'large') {
    return executeSequential(ctx, team, params, tier);
  }

  // Phase plan was already computed during strategy selection
  // Execute each phase in order, parallel phases use Promise.all
  const allResults: MemberResult[] = [];
  let phaseContext = params.context || '';

  for (const phase of phasePlan) {
    if (phase.type === 'parallel') {
      const phaseResults = await executeParallelSubset(
        ctx, team, params, phase.members, phaseContext,
      );
      allResults.push(...phaseResults);
      phaseContext = phaseResults
        .filter((r) => r.status === 'completed')
        .map((r) => `### ${r.role}\n${r.content}`)
        .join('\n\n');
    } else {
      const phaseResults = await executeSequentialSubset(
        ctx, team, params, phase.members, phaseContext, tier,
      );
      allResults.push(...phaseResults);
      const lastSuccessful = phaseResults.filter((r) => r.status === 'completed').pop();
      if (lastSuccessful) {
        phaseContext = `### ${lastSuccessful.role}\n${lastSuccessful.content}`;
      }
    }
  }

  return allResults;
}
```

## Local Model Adaptations

This is Cerebro's key differentiator. No other framework even attempts team orchestration with local models. Here's how Cerebro makes it work:

### Serialized Execution Awareness

Local models process one inference at a time (`asyncio.Lock` in `backend/local_models/inference.py`). Parallel team execution on local models becomes serialized at the lock level. The system handles this gracefully:

1. All member delegation requests fire simultaneously via `Promise.all`
2. The backend queues them at the inference lock
3. Members execute one-at-a-time
4. `member_started` / `member_completed` events stream to the UI as each finishes
5. The user sees a live progress indicator: "Expert A completed. Expert B working... Expert C queued."

This isn't a hack — it's the correct behavior. The results are identical to true parallel execution; only wall-clock time differs. And the progress streaming gives users clear feedback throughout.

### Member Cap Advisory

Small model teams work best with 2–3 members. More members means more context accumulation (sequential) or more results to synthesize (parallel), both of which strain small context windows. The `propose_team` tool emits a warning when a team has more than 3 members and a small model is active:

```typescript
if (tier === 'small' && members.length > 3) {
  // Warning in proposal card, not a hard block
  proposal.warnings = [
    `This team has ${members.length} members. Teams with 3 or fewer members ` +
    `work best with small models. Consider removing less critical members.`,
  ];
}
```

This is advisory, not enforced. A user who wants a 5-member team on a 4B model can have one — it'll just take longer and use more context.

### Template-Based Coordination

Small models never make free-form coordination decisions. Strategy selection is deterministic (keyword heuristic). Synthesis uses a minimal prompt. Member filtering doesn't happen — all members participate. This removes every decision point where a small model could hallucinate or produce inconsistent output.

The quality of team orchestration on small models comes from three things: (1) each member's individual response quality (which small models handle well for focused tasks), (2) reliable strategy selection via heuristics, and (3) simple synthesis that lets the model focus on merging content rather than following complex formatting instructions.

### Token Budget Tracking

The coordinator tracks cumulative token usage across member runs. For small models with tight context budgets, this prevents runaway token consumption:

```typescript
const TIER_TEAM_BUDGETS: Record<ModelTier, number> = {
  small: 6_000,   // ~24K chars total across all members
  medium: 24_000,  // ~96K chars
  large: 100_000,  // ~400K chars (effectively uncapped)
};

// During execution, track cumulative chars
let totalChars = 0;
for (const member of members) {
  // ... delegate and collect result ...
  totalChars += result.messageContent.length;

  if (totalChars > TIER_TEAM_BUDGETS[tier] && remainingMembers.length > 0) {
    // Budget approaching — skip remaining lower-priority members
    emitTeamEvent(ctx, 'budget_warning', {
      teamId: team.id,
      message: `Token budget reached. Skipping ${remainingMembers.length} remaining member(s).`,
    });
    break;
  }
}
```

## Event System & UX

### New Event Types

```typescript
// src/agents/types.ts — extend RendererAgentEvent union

export type RendererAgentEvent =
  // ... existing events ...
  | {
      type: 'team_started';
      teamId: string;
      teamName: string;
      strategy: string;
      memberCount: number;
    }
  | {
      type: 'member_queued';
      teamId: string;
      memberId: string;
      memberName: string;
      role: string;
    }
  | {
      type: 'member_started';
      teamId: string;
      memberId: string;
      memberName: string;
    }
  | {
      type: 'member_completed';
      teamId: string;
      memberId: string;
      memberName: string;
      status: 'completed' | 'error';
    }
  | {
      type: 'team_synthesis';
      teamId: string;
    }
  | {
      type: 'team_completed';
      teamId: string;
      status: 'completed' | 'error';
      successCount: number;
      totalCount: number;
    };
```

### TeamRunCard Component

`src/components/chat/TeamRunCard.tsx` renders inline progress during team execution:

```
During execution:
+---------------------------------------------------+
| [team icon]  Content Team                         |
| Strategy: sequential                              |
+---------------------------------------------------+
| [✓] Market Researcher     completed               |
| [⟳] Copywriter            working...              |
| [○] Technical Reviewer     queued                  |
+---------------------------------------------------+

After completion:
+---------------------------------------------------+
| [✓]  Content Team  (3/3 completed)                |
| Strategy: sequential                              |
+---------------------------------------------------+
| [✓] Market Researcher     [Show response]         |
| [✓] Copywriter            [Show response]         |
| [✓] Technical Reviewer    [Show response]         |
+---------------------------------------------------+

Partial failure:
+---------------------------------------------------+
| [!]  Content Team  (2/3 completed)                |
| Strategy: parallel                                |
+---------------------------------------------------+
| [✓] Market Researcher     [Show response]         |
| [✗] Copywriter            timed out               |
| [✓] Technical Reviewer    [Show response]         |
+---------------------------------------------------+
```

Each member's full response is expandable. The synthesized result appears in the main message flow after the card. `TeamRunCard` follows the same styling patterns as `RunLogCard` and `ToolCallCard` — zinc surfaces, cyan accents, monospace detail text.

### ChatContext Integration

`ChatContext.tsx` handles team events in the same event handler that processes `delegation_start` and `delegation_end`. Team events are accumulated on the assistant message and rendered via `TeamRunCard`:

```typescript
// In the agent event handler
case 'team_started':
  updateMessage(convId!, assistantId, {
    teamRun: {
      teamId: event.teamId,
      teamName: event.teamName,
      strategy: event.strategy,
      members: [],
      status: 'running',
    },
  });
  break;

case 'member_completed':
  // Update the member's status in the teamRun
  break;

case 'team_completed':
  updateMessage(convId!, assistantId, (prev) => ({
    ...prev,
    teamRun: { ...prev.teamRun!, status: event.status },
  }));
  break;
```

## Team Creation & Proposal

### `propose_team` Tool

Mirrors the `propose_expert` pattern from `expert-proposal-tools.ts`. The LLM proposes a team through structured parameters, and the user reviews it inline.

```typescript
// src/agents/tools/team-proposal-tools.ts

export function createProposeTeam(ctx: ToolContext): AgentTool {
  return {
    name: 'propose_team',
    description:
      'Propose creating a team of experts that work together on complex tasks. ' +
      'Teams coordinate multiple experts with automatic strategy selection. ' +
      'Use when the user needs multi-perspective analysis, review pipelines, ' +
      'or collaborative workflows.',
    label: 'Propose Team',
    parameters: Type.Object({
      name: Type.String({
        description: 'Short team name (e.g. "Content Team", "Code Review Pipeline")',
      }),
      description: Type.String({
        description: 'What this team does and when to use it (1-2 sentences)',
      }),
      strategy: Type.Optional(
        Type.Union(
          [Type.Literal('auto'), Type.Literal('sequential'), Type.Literal('parallel')],
          { description: 'Default execution strategy. "auto" lets the system choose per-task.' },
        ),
      ),
      members: Type.Array(
        Type.Object({
          expert_id: Type.Optional(Type.String({
            description: 'ID of an existing expert. Omit to propose a new expert inline.',
          })),
          name: Type.Optional(Type.String({
            description: 'Name for a new expert (required if expert_id is omitted)',
          })),
          role: Type.String({
            description: 'This member\'s role in the team (e.g. "researcher", "editor", "reviewer")',
          }),
          description: Type.Optional(Type.String({
            description: 'What this member does (required for new experts)',
          })),
          order: Type.Optional(Type.Number({
            description: 'Execution order for sequential strategy (0-based)',
          })),
        }),
        { description: 'Team members — existing experts or new expert proposals' },
      ),
      coordinator_prompt: Type.Optional(
        Type.String({
          description: 'Instructions for how the team should decompose and coordinate tasks',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      // Validate existing expert references
      const errors: string[] = [];
      for (const member of params.members) {
        if (member.expert_id) {
          try {
            await backendRequest(ctx.backendPort, 'GET', `/experts/${member.expert_id}`);
          } catch {
            errors.push(`Expert "${member.expert_id}" not found`);
          }
        } else if (!member.name || !member.description) {
          errors.push(`New member "${member.role}" needs both name and description`);
        }
      }

      if (errors.length > 0) {
        return textResult(`Team proposal has issues:\n${errors.map((e) => `- ${e}`).join('\n')}`);
      }

      const proposal = {
        type: 'team_proposal',
        name: params.name,
        description: params.description,
        strategy: params.strategy ?? 'auto',
        members: params.members,
        coordinatorPrompt: params.coordinator_prompt ?? null,
      };
      return textResult(JSON.stringify(proposal));
    },
  };
}
```

### TeamProposalCard Component

`src/components/chat/TeamProposalCard.tsx` renders the team proposal inline with the same propose-preview-save pattern:

```
+---------------------------------------------------+
| [team icon]  Content Team               [Proposed] |
+---------------------------------------------------+
| Research, draft, and review content as a team.     |
| Strategy: auto                                     |
+---------------------------------------------------+
| Members:                                           |
|   1. Market Researcher (researcher) — existing     |
|   2. Copywriter (writer) — NEW expert              |
|   3. Editor (reviewer) — existing                  |
+---------------------------------------------------+
| [Save Team]                          [Dismiss]     |
+---------------------------------------------------+
```

**Save flow**:
1. Create any new member experts via `POST /experts`
2. Create the team via `POST /experts` with `type: 'team'`, `team_members`, `strategy`, and `coordinator_prompt`
3. Refresh expert list in `ExpertContext`
4. Update proposal status to `'saved'`

**Inline expert creation**: When a team member references a new expert (no `expert_id`), the save flow creates that expert first, then uses the newly created ID in the team's `team_members` list. This enables "I need a content team" → Cerebro proposes the team AND the experts it needs, all saved in one action.

### System Prompt Guidance

A `TEAM_PROPOSAL_GUIDANCE` constant is added to `recall.py`, injected into Cerebro's system prompt alongside `EXPERT_PROPOSAL_GUIDANCE`:

```python
TEAM_PROPOSAL_GUIDANCE = """## Team Proposals

You can propose creating a team of experts using the `propose_team` tool. \
Teams coordinate multiple experts to handle complex, multi-perspective tasks.

### When to Propose

Propose a team when the user needs:
- **Multi-perspective analysis:** "Review this from engineering and business angles"
- **Pipeline workflows:** "Research, write, and edit this article"
- **Quality assurance:** "Draft this and have it reviewed"
- **Collaborative tasks:** "I need marketing and design to work together"

Do NOT propose when:
- A single expert can handle the task
- The user wants quick, one-off help
- The task is simple enough for Cerebro to handle directly

### Team Design Tips

- 2-4 members is ideal. More members = more coordination overhead.
- Use 'auto' strategy unless the workflow is clearly sequential.
- Assign clear, distinct roles — avoid overlapping responsibilities.
- For sequential teams, set member `order` to define the pipeline.
- Reference existing experts when possible; propose new ones only when needed."""
```

## Error Handling & Resilience

### Per-Member Failure Modes

Each team member has an `on_error` field that determines behavior on failure:

| `on_error` | Behavior | Use When |
|-----------|----------|----------|
| `skip` (default) | Continue without this member; note gap in synthesis | Non-critical members (supplementary analysis, optional review) |
| `retry` | Attempt once more; skip if retry also fails | Important members that may fail transiently (timeout, rate limit) |
| `fail` | Abort entire team run | Critical members whose output is required (e.g., the primary researcher in a research→write pipeline) |

### Timeout Hierarchy

| Level | Timeout | Controlled By |
|-------|---------|---------------|
| Per-member delegation | 180,000ms (3 min) | `waitForCompletion()` call in execution strategy |
| Team-level (sequential) | Sum of member timeouts | Implicit from sequential execution |
| Team-level (parallel) | Max of member timeouts | Implicit from `Promise.all` |
| Strategy analysis | 30,000ms (30s) | Separate timeout on the analysis inference call |
| Synthesis | 60,000ms (1 min) | Separate timeout on the synthesis inference call |

### Cascading Failure Prevention

If more than 50% of members fail (and none have `on_error: 'fail'`), the team run continues but the synthesis prompt explicitly notes which members failed and why. The coordinator does NOT attempt to fill in the gaps — it synthesizes from available results and flags incomplete coverage:

```typescript
const failedMembers = memberResults.filter((r) => r.status === 'error');
if (failedMembers.length > memberResults.length / 2) {
  synthesisPrompt += `\n\nWARNING: ${failedMembers.length} of ${memberResults.length} ` +
    `team members failed. The response below is based on partial results. ` +
    `Failed members: ${failedMembers.map((m) => m.role).join(', ')}.`;
}
```

## Competitive Analysis

### Feature Comparison

| Feature | Cerebro | OpenAI Agents SDK | Anthropic Agent Teams | Google ADK |
|---------|---------|------------------|-----------------------|------------|
| Parallel execution | ✓ | ✗ (sequential only) | ✓ | ✓ |
| Sequential pipelines | ✓ | ✓ (handoffs) | ✓ | ✓ |
| Dynamic strategy selection | ✓ | ✗ | ✗ | Partial (AutoFlow) |
| Local model support | ✓ | ✗ | ✗ | ✗ |
| Offline operation | ✓ | ✗ | ✗ | ✗ |
| Tier-adaptive behavior | ✓ | ✗ | ✗ | ✗ |
| Conversational team creation | ✓ | ✗ | ✗ | ✗ |
| Team-level memory | ✓ | ✗ | ✗ | ✗ |
| Progressive streaming | ✓ | N/A | Partial | Partial |
| No configuration files | ✓ | ✗ (Python code) | ✗ (YAML/code) | ✗ (Python code) |

### Cerebro's Unique Position

Three capabilities that no competitor offers:

1. **Works offline with local models.** Every other framework requires cloud API access for multi-agent coordination. Cerebro teams run on a 4B parameter model with no network connection. The coordination is simpler (heuristic strategy, template synthesis) but the results are real and useful.

2. **Tier-adaptive orchestration.** The same team definition produces different coordination behavior based on the active model's capability. Cloud models get full autonomous coordination. Medium models get structured decision templates. Small models get deterministic heuristics. This isn't "degraded mode" — it's strategy that matches the tool. A small model executing a well-structured pipeline produces better results than a small model trying and failing to do autonomous coordination.

3. **Teams improve over time.** The playbook context file accumulates coordination patterns, lessons learned, and strategy preferences. After 10 runs, a Content Team's playbook might note "sequential works better for blog posts, parallel works better for social media batches." This context is injected into future coordination decisions. No other framework has team-level learning.

## Key Decisions & Trade-offs

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Strategy selection | Task-adaptive (dynamic) | Fixed strategies force users to predict the best approach. Dynamic selection matches strategy to task, which is more powerful and requires no configuration. |
| Small model strategy | Deterministic heuristic | LLM-based routing with <8B models produces unreliable results. Keyword heuristics are fast, predictable, and correct for common patterns. Quality comes from individual member responses, not routing sophistication. |
| Coordinator implementation | Tool logic, not separate agent | A coordinator agent would consume its own turn budget, add latency, and require a new runtime concept. Putting coordination in the tool keeps it fast and reuses existing infrastructure. |
| Context distillation | Character truncation, not LLM summarization | LLM summarization between pipeline steps doubles inference cost and adds latency. Smart truncation (prioritize recent, budget-aware) is fast and predictable. |
| Hybrid strategy gating | Large models only | Hybrid requires decomposing a task into parallel and sequential phases, which needs strong multi-step reasoning. Medium models can do binary parallel/sequential classification but not phase decomposition. |
| Member failure default | `skip` | Most resilient default. Failed members are noted in synthesis rather than aborting the run. Users can override to `fail` for critical pipeline members. |
| Team memory storage | Settings table (same as expert context files) | No new storage system. Playbooks are markdown, stored with `memory:context:team:{id}` key. Same CRUD, same API, same UI pattern. |
| No debate strategy (v1) | Deferred | Debate (two-round argue-and-revise) is powerful for contested topics but doubles token cost and complexity. Parallel + sequential cover 95% of use cases. Debate can be added as a v2 strategy without architectural changes. |
| Max team members | Advisory (3 for small models), not enforced | Hard limits frustrate users. Advisory warnings educate without blocking. A user who wants a 5-member team on a 4B model understands the trade-off. |

## Implementation Phases

Each phase delivers a working increment.

### Phase 1: Sequential Strategy + Core Infrastructure

1. Add `strategy` and `coordinator_prompt` columns to `Expert` model in `backend/models.py`
2. Add `delegation_prompt` and `on_error` fields to `TeamMember` schema in `backend/experts/schemas.py`
3. Create `delegate_to_team` tool in `src/agents/tools/delegation-tools.ts` with sequential strategy only
4. Add `selectStrategySmall` heuristic function
5. Add `distillContext` function for inter-member context compression
6. Add `synthesizeResults` function with tier-specific synthesis prompts
7. Register `delegate_to_team` in `CEREBRO_TOOLS` in `src/agents/tools/index.ts`
8. Add team-related event types to `RendererAgentEvent` in `src/agents/types.ts`

**Deliverable**: Cerebro can delegate to teams using sequential strategy. Small model heuristic and synthesis templates work. Context distillation prevents token budget overflow.

### Phase 2: Parallel Strategy + Event System + UI

9. Add parallel execution strategy (`executeParallel` function)
10. Add concurrency slot check with sequential fallback
11. Add `member_queued` / `member_started` / `member_completed` progress events
12. Create `src/components/chat/TeamRunCard.tsx` component
13. Update `ChatContext.tsx` to handle team events and render `TeamRunCard`
14. Update `ChatMessage.tsx` to render `TeamRunCard` inline

**Deliverable**: Teams can run in parallel with real-time progress streaming. UI shows per-member status and expandable results.

### Phase 3: Dynamic Strategy Selection + Hybrid

15. Add LLM-powered strategy analysis for large models (strategy analysis prompt + inference call)
16. Add structured template strategy analysis for medium models
17. Implement hybrid strategy execution (`executeHybrid`)
18. Add team playbook fetch and injection into synthesis prompts
19. Add playbook storage via settings table (`memory:context:team:{id}`)
20. Trigger team-level memory extraction after team runs

**Deliverable**: Teams dynamically choose the optimal strategy per task. Large models can decompose tasks into hybrid parallel/sequential phases. Team playbooks accumulate over time.

### Phase 4: Team Proposals + Polish

21. Create `src/agents/tools/team-proposal-tools.ts` with `propose_team`
22. Create `src/components/chat/TeamProposalCard.tsx`
23. Add team proposal detection to `ChatContext.tsx` `tool_end` handler
24. Add `TEAM_PROPOSAL_GUIDANCE` to `recall.py` system prompt assembly
25. Implement inline expert creation during team save flow
26. Add team proposal snapshot tracking (same pattern as expert proposals)
27. Register `propose_team` in `CEREBRO_TOOLS` and `TOOL_FACTORIES`

**Deliverable**: Users create teams through conversation. Teams can include both existing and new experts. Proposals render inline with save/dismiss.

## Files Summary

### Files Created

| File | Purpose |
|------|---------|
| `src/agents/tools/team-proposal-tools.ts` | `propose_team` tool for conversational team creation |
| `src/components/chat/TeamProposalCard.tsx` | Inline team proposal card (save/dismiss) |
| `src/components/chat/TeamRunCard.tsx` | Team execution progress card (member status, expandable results) |

### Files Modified

| File | Change |
|------|--------|
| `backend/models.py` | Add `strategy` and `coordinator_prompt` columns to `Expert` |
| `backend/experts/schemas.py` | Add `delegation_prompt`, `on_error` to `TeamMember`; add `strategy`, `coordinator_prompt` to create/update/response schemas |
| `src/agents/tools/delegation-tools.ts` | Add `delegate_to_team` tool, strategy selection, execution strategies, synthesis, context distillation |
| `src/agents/tools/index.ts` | Register `delegate_to_team` and `propose_team` in `CEREBRO_TOOLS` and `TOOL_FACTORIES` |
| `src/agents/types.ts` | Add team event types (`team_started`, `member_queued`, `member_started`, `member_completed`, `team_synthesis`, `team_completed`) to `RendererAgentEvent` |
| `src/types/chat.ts` | Add `TeamProposal` and `TeamRun` interfaces, add `teamProposal` and `teamRun` to `Message` |
| `src/context/ChatContext.tsx` | Handle team events, detect team proposals in `tool_end`, render `TeamRunCard` |
| `src/components/chat/ChatMessage.tsx` | Render `TeamProposalCard` and `TeamRunCard` inline |
| `backend/memory/recall.py` | Add `TEAM_PROPOSAL_GUIDANCE` constant, inject into Cerebro system prompt |

## Verification

1. **Sequential team**: Create a 3-member team (researcher → writer → editor) with `strategy: 'sequential'`. Ask "write a blog post about AI agents." Members execute in order, each building on the previous result. `TeamRunCard` shows per-member progress. Final response is a synthesized blog post.

2. **Parallel team**: Create a 3-member team (market researcher, competitive analyst, customer researcher) with `strategy: 'parallel'`. Ask "analyze the market for AI coding assistants." All members work simultaneously (or serialize on local models with progress events). Results are synthesized into a unified market analysis.

3. **Auto strategy**: Create a team with `strategy: 'auto'`. Ask a task that suits parallel execution ("compare these three approaches") and a task that suits sequential ("research this topic, then write about it"). Verify the system selects the appropriate strategy for each.

4. **Small model execution**: Load a 4B local model. Run a sequential team. Verify: heuristic strategy selection (no LLM analysis call), template-based synthesis, context distillation between steps, all progress events stream correctly.

5. **Partial failure**: Create a team where one member references a disabled expert. Run the team. Verify: failed member is skipped (default `on_error: 'skip'`), synthesis proceeds from remaining members, `TeamRunCard` shows the failure state.

6. **Team proposal**: Ask "I need a team for content creation." Cerebro proposes a team via `propose_team`. `TeamProposalCard` renders inline. Save creates the team (and any new member experts). The team appears in the expert catalog.

7. **Token budget**: Run a team on a small model with 4 members. Verify token budget tracking stops execution if cumulative output exceeds the tier limit, with a clear budget warning event.

8. **Playbook**: Run a team twice. After the first run, verify a playbook context file exists at `memory:context:team:{id}`. On the second run, verify the playbook is injected into the synthesis prompt.

9. **Depth limit**: Attempt to nest a team delegation inside another delegation. Verify the depth check prevents it with a clear error message.

10. **Concurrency fallback**: Start 3 separate expert runs, then trigger a 4-member parallel team. Verify the team falls back to sequential execution because only 2 of 5 concurrent slots are available.
