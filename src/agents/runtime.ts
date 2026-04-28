/**
 * AgentRuntime — manages concurrent Claude Code subprocess runs.
 *
 * This is the post-collapse implementation: every chat run spawns a
 * `claude -p ... --agent <name>` subprocess via ClaudeCodeRunner with
 * `cwd: <cerebro-data-dir>`. There is no JS agent loop, no model
 * resolver, no tool registry, no MCP bridge. Subagents are defined as
 * project-scoped Markdown files under `<dataDir>/.claude/agents/` by
 * the installer; delegation is handled by Claude Code's built-in
 * `Agent` tool inside its own subprocess.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ipcMain } from 'electron';
import type { AgentRunRequest, ActiveRunInfo, RendererAgentEvent } from './types';

/**
 * Minimal sink interface for run events. Both WebContents (renderer) and
 * the Telegram bridge implement it. Keeping it narrow lets the bridge
 * consume agent runs without spawning a hidden renderer.
 */
export interface AgentEventSink {
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
}
import { ClaudeCodeRunner } from '../claude-code/stream-adapter';
import { TaskPtyRunner } from '../pty/TaskPtyRunner';
import { TerminalBufferStore } from '../pty/TerminalBufferStore';
import { getAgentNameForExpert, installAll, installExpert, expertAgentName } from '../claude-code/installer';
import fsSync from 'node:fs';
import { IPC_CHANNELS } from '../types/ipc';
import { buildSystemPrompt } from '../i18n/language-directive';

/** Cap concurrent runs to prevent spawning a wall of subprocesses. */
const MAX_CONCURRENT_RUNS = 5;

const DELIVERABLE_EXAMPLE = `<deliverable kind="markdown|code_app|mixed" title="Short title">
# Heading

Full markdown body here. For code_app, include: overview, file structure, setup commands, run command, notes. This is what the user sees in the Deliverable tab.
</deliverable>`;

const RUN_INFO_EXAMPLE = `<run_info>
{
  "preview_type": "web|expo|cli|static",
  "setup_commands": ["npm install"],
  "start_command": "npm run dev",
  "preview_url_pattern": "Local:\\\\s+(https?://\\\\S+)",
  "notes": "optional"
}
</run_info>`;

const DELIVERABLE_HARD_RULE = `**ALWAYS end every run with a \`<deliverable kind="…" title="…">…</deliverable>\` block.** \`kind\` MUST be exactly one of \`markdown\`, \`code_app\`, or \`mixed\` (no other values, no pipe-separated lists — pick ONE). Cerebro uses this block as the machine-readable completion sentinel — without it, your work is invisible to the user and the task will NOT complete. This applies to EVERY task no matter how trivial: a one-line haiku, a one-word answer, a "hello world" — wrap the final result in a deliverable block. Do NOT output your final answer as plain text outside the block. If you've already written the result as prose, your last action is still to emit the deliverable block with the same content inside.`;

interface ActiveRun {
  runId: string;
  conversationId: string;
  expertId: string | null;
  userContent: string;
  startedAt: number;
  accumulatedText: string;
  /** Stream-json runner (used for chat runs and task clarify phase). */
  runner: ClaudeCodeRunner | null;
  /** PTY runner (used for task execute/follow_up — sole process, no stream runner). */
  ptyRunner: TaskPtyRunner | null;
  isTaskRun: boolean;
}

/**
 * Synthesize a `<deliverable>` envelope when the agent exited cleanly with
 * substantive output but never emitted the tagged block itself. We strip
 * known TUI footer noise (bypass banner, token counter, resume line, agent
 * label bubble, and the `</task_direct>` user-prompt tail) and wrap the
 * cleaned tail in a minimal markdown deliverable so the downstream parser
 * and Task card have something to render.
 */
function wrapProseAsDeliverable(raw: string): string {
  let cleaned = raw;
  // Drop Claude Code's session goodbye line plus the --resume hint.
  cleaned = cleaned.replace(/Resume this session with:[\s\S]*$/m, '');
  // Drop the "bypass permissions on" TUI footer line and token count.
  cleaned = cleaned.replace(/[›»▸▶]{1,3}\s*bypass permissions[^\n]*\d+\s*tokens[^\n]*/g, '');
  // Drop the agent-name label bubble that Claude Code prints after responses.
  cleaned = cleaned.replace(/^\s*[a-z0-9-]+\s*$/gm, '');
  // Drop the task_direct closing tag and anything above it (user prompt echo).
  const afterTaskDirect = cleaned.lastIndexOf('</task_direct>');
  if (afterTaskDirect >= 0) {
    cleaned = cleaned.slice(afterTaskDirect + '</task_direct>'.length);
  }
  // Cap body so we don't embed megabytes of tool-call transcripts.
  const body = cleaned.trim().slice(-8000).trim() || 'Task finished.';
  return `<deliverable kind="markdown" title="Task Result">\n${body}\n</deliverable>`;
}

interface ExpertNameLookup {
  id: string;
  name: string;
}

export class AgentRuntime {
  private activeRuns = new Map<string, ActiveRun>();
  private backendPort: number;
  private dataDir: string;
  private syncChain: Promise<void> = Promise.resolve();
  public terminalBufferStore: TerminalBufferStore;

  /**
   * Main-process event bus. The Claude Code chat runner emits events to
   * the renderer via `webContents.send`, but main-process consumers (the
   * `expert_step` action in particular) cannot observe those — its
   * `webContents.ipc.on` only fires for renderer→main messages. Without
   * this bridge, every `run_expert` step in a routine waits forever for a
   * `done` event that never arrives, and only the dag executor's 5-min
   * wall clock frees the run. Subscribe via `runtime.on('event:<runId>',
   * cb)` to receive every agent event in main.
   */
  private bus = new EventEmitter();

  constructor(backendPort: number, dataDir: string) {
    this.backendPort = backendPort;
    this.dataDir = dataDir;
    this.terminalBufferStore = new TerminalBufferStore(dataDir);
    // Allow many step actions to listen on different runs concurrently.
    this.bus.setMaxListeners(50);
  }

  /** Subscribe to agent events for a specific run from main-process code. */
  onAgentEvent(runId: string, listener: (event: RendererAgentEvent) => void): () => void {
    const channel = `event:${runId}`;
    this.bus.on(channel, listener);
    return () => this.bus.off(channel, listener);
  }

  /** Internal: emit a single agent event on both the main bus and the renderer channel. */
  private deliverEvent(runId: string, webContents: AgentEventSink, event: RendererAgentEvent): void {
    this.bus.emit(`event:${runId}`, event);
    if (!webContents.isDestroyed()) {
      webContents.send(`agent:event:${runId}`, event);
    }
  }

  /**
   * Spawn a Claude Code subprocess for one chat turn.
   * Returns the runId immediately; events stream over `agent:event:<runId>`.
   */
  async startRun(
    webContents: AgentEventSink,
    request: AgentRunRequest,
  ): Promise<string> {
    if (this.activeRuns.size >= MAX_CONCURRENT_RUNS) {
      throw new Error('Too many concurrent agent runs');
    }

    const isTaskRun = request.runType === 'task';
    const runId = request.runIdOverride || crypto.randomUUID().replace(/-/g, '').slice(0, 32);
    const { conversationId, content, expertId } = request;

    // Resolve which subagent to invoke. Default to the main "cerebro" agent
    // when no expert is specified. For experts, we must guarantee both (a) the
    // slug is in the sidecar index AND (b) the `<slug>.md` file exists on disk
    // at the time we spawn `claude -p --agent <slug>`. Otherwise the subprocess
    // exits 1 with empty stderr and the user sees the generic "exited
    // unexpectedly" error.
    let agentName = 'cerebro';
    let agentResolutionError: string | null = null;
    if (expertId) {
      agentName = await this.resolveExpertAgentSlug(expertId).catch((err: Error) => {
        agentResolutionError = err.message;
        return '';
      });
    }

    const isExternalWorkspace =
      isTaskRun && !!request.workspacePath && !request.workspacePath.startsWith(this.dataDir);

    // Build the prompt. Task runs get a structured envelope; chat runs
    // get conversation-history context prepended.
    let fullPrompt = content;

    if (isTaskRun && request.taskPhase === 'plan') {
      const maxQ = request.maxClarifyQuestions ?? 5;
      const answersSection = request.clarificationAnswers
        ? `\n## User's answers to your clarifying questions\n${request.clarificationAnswers}\n`
        : '';
      fullPrompt = `<task_plan>
You are Cerebro in PLANNING MODE. You will NOT execute any work here. Your ONLY job is to (a) optionally ask clarifying questions, then (b) write a PLAN.md file that the user will approve before execution begins.

Your working directory is the per-task workspace at $PWD. You may only use the \`Write\` tool — no Bash, no Read, no Edit, no Agent.

## Decision tree

1. Read the goal${request.clarificationAnswers ? ' AND the user\'s answers below' : ''}.
2. ${request.clarificationAnswers
        ? 'The user already answered clarifying questions. Do NOT ask more — go straight to step 4.'
        : `If the goal is ambiguous and you'd likely waste turns on wrong assumptions, ask 1–${maxQ} clarifying questions as a \`<clarification>\` block and STOP. You will be re-invoked with the answers.`}
3. ${request.clarificationAnswers
        ? ''
        : 'If the goal is clear enough to plan without asking (one-shots, very specific requests), skip straight to step 4.'}
4. Write \`PLAN.md\` in $PWD using the \`Write\` tool. Format below. Then STOP — emit no further output.

${request.clarificationAnswers ? '' : `## Clarification format (only when needed)

<clarification>
{"questions":[
  {"id":"q1","kind":"text","q":"What's the primary use case you want to nail?","placeholder":"e.g. logging my workouts while at the gym"},
  {"id":"q2","kind":"select","q":"Which platform?","options":["iOS","Android","Both (Expo)","Web"],"default":"Both (Expo)"},
  {"id":"q3","kind":"bool","q":"Include mock data so it feels real on first launch?","default":true}
]}
</clarification>

- Max ${maxQ} questions; three is usually plenty.
- \`kind\` is one of: \`text\`, \`select\` (requires \`options\`), \`bool\`.
- Every question must be answerable in seconds and meaningfully change what you build.
- Do NOT ask about things you should decide yourself (framework, file structure, which expert to use).
- Do NOT ask about things already specified in the goal.
- After emitting the \`<clarification>\` block, stop. Do not write PLAN.md in the same run.
`}

## PLAN.md format

The user sees this as an interactive checklist. Keep items short, concrete, and ordered. 5–15 items is the sweet spot.

\`\`\`markdown
# Plan

**Goal:** <one-sentence restatement of what we're building>

## Steps
- [ ] <short, actionable step>
- [ ] <another step>
- [ ] <...>
\`\`\`

- Use GFM task list syntax exactly: \`- [ ] \` with a space inside the brackets, one item per line.
- Steps should describe OUTPUT, not internal deliberation ("Scaffold index.html", not "Think about structure").
- Include a "**Goal:**" line as shown.
- Do NOT add any other sections (no "Risks", no "Open Questions", no headings beyond \`# Plan\` and \`## Steps\`).
- Do NOT wrap the file in code fences when writing it.

## Hard rules

- You are in PLANNING MODE. Do NOT execute any work, create any code, or run any commands.
- Only the \`Write\` tool is permitted — and only to create \`PLAN.md\` at $PWD.
- After writing PLAN.md (or emitting \`<clarification>\`), stop. No narration, no summary, no deliverable.
- The tag \`<clarification>\` is a control marker — emit it verbatim regardless of the user's language.

## Goal

${content}
${answersSection}
</task_plan>`;
    } else if (isTaskRun && request.taskPhase === 'follow_up') {
      const maxPhases = request.maxPhases ?? 4;
      const wsPath = request.workspacePath ?? '$PWD';
      fullPrompt = `<task_follow_up>
You are operating in AUTONOMOUS TASK MODE — this is a FOLLOW-UP run on a previously completed task. The user wants you to modify, extend, or redo part of the output.

Your working directory is the same isolated per-task workspace at \`${wsPath}\`. It contains all files from the previous run(s). You have full Read/Edit/Write/Bash access inside it.

## Context from previous run

${request.followUpContext ?? '(no context available)'}

## Follow-up instruction

${content}

## Protocol

1. Read the follow-up instruction carefully. Decide if this requires:
   - **A small edit** (typo fix, wording change, style tweak) → directly edit files or rewrite the deliverable.
   - **A moderate extension** (add a section, new feature, refactor a component) → optionally plan 1–${maxPhases} phases, then execute.
   - **A major redo** (fundamentally different output) → plan and execute as a fresh task, reusing what's salvageable from the workspace.

2. For code_app/mixed deliverables: inspect the workspace first (\`ls\`, \`cat\` key files) to understand current state before making changes.

3. Use the expert roster (\`list-experts\` via Bash) and delegate via the \`Agent\` tool when phases benefit from specialist expertise. For simple edits, do the work directly — no need to delegate.

4. If you plan phases, emit a \`<plan>\` block. If not, skip straight to editing and synthesizing.

5. After all changes, emit a new deliverable block with the COMPLETE updated deliverable (not just the diff — the full final version):

${DELIVERABLE_EXAMPLE}

For \`code_app\` or \`mixed\`, also emit an updated \`<run_info>\` block immediately after if the run command changed.

## Hard rules

- ${DELIVERABLE_HARD_RULE}
- NEVER ask the user for clarification, confirmation, or approval.
- NEVER write outside the workspace directory.
- NEVER spawn long-running dev servers or background processes.
- NEVER create more than ${maxPhases} phases.
- If the instruction is unclear, interpret it as best you can and explain your interpretation in the deliverable.
</task_follow_up>`;
    } else if (isTaskRun && request.taskPhase === 'execute') {
      fullPrompt = `<task_execute>
You are operating in AUTONOMOUS TASK MODE for a high-level goal. Your working directory is an isolated per-task workspace at $PWD. You have full Read/Edit/Write/Bash access inside it.

## Workspace

- You are currently cd'd into the task workspace (\`${request.workspacePath ?? '$PWD'}\`).
- \`PLAN.md\` at $PWD contains the user-approved checklist of steps to execute. This is the spec for this run.
- Anything you write here is persisted and owned by the task. The user will browse it in the Deliverable tab.
- \`.claude/\` is symlinked from the parent so skills and agents are still discovered.

## Protocol

### 1. Read PLAN.md
\`Read\` \`$PWD/PLAN.md\` first. This is the user-approved plan. Work the checklist in order.

### 2. Decide the deliverable kind
From the plan, decide whether this task produces:
- \`markdown\` — a standalone markdown artifact (spec, brief, essay, outline).
- \`code_app\` — a runnable project on disk in the workspace.
- \`mixed\` — both.

### 3. Work the checklist
For each unchecked item in PLAN.md:
1. Do the work (delegate via the \`Agent\` tool to an appropriate expert when the task benefits from specialist expertise; otherwise do it directly).
2. When the item is done, \`Edit\` \`$PWD/PLAN.md\` to change that specific line from \`- [ ]\` to \`- [x]\`. Change ONLY that one line — do not rewrite unrelated lines.
3. Move to the next unchecked item.

You may run the \`list-experts\` skill (via Bash) up front to see which specialists are available. For each expert you create along the way, invoke the \`create-expert\` skill directly and without user confirmation, then run \`bash "$CLAUDE_PROJECT_DIR/.claude/scripts/rematerialize-experts.sh"\` so the new expert is invocable in this same run.

### 4. For code_app or mixed: smoke-test the build
Before synthesis, run a bounded verification command (e.g. \`npm install\` + \`npm run build\` for web, \`npx tsc --noEmit\` for TS, \`python -m py_compile\` for Python, \`npx expo-doctor\` for Expo). If it fails, have at most one fix-up pass. Do NOT start long-running dev servers here — the UI spawns those post-completion.

### 5. Synthesize
Emit the final deliverable block. For \`markdown\`: a standalone markdown artifact. For \`code_app\`: a README-style summary of what was built, structure, and how to run it. For \`mixed\`: both in one block.

${DELIVERABLE_EXAMPLE}

### 6. For code_app or mixed: emit run info
Immediately after the \`<deliverable>\` block, emit exactly one \`<run_info>\` block describing how to run the app. The UI uses this to wire the "Start dev server" button.

${RUN_INFO_EXAMPLE}

- \`preview_type\`: \`web\` (dev server emits a URL), \`expo\` (Metro bundler + QR code), \`cli\` (non-interactive, runs and exits), \`static\` (just open index.html).
- \`preview_url_pattern\`: Python-style regex with one capture group that extracts the URL from stdout.
- Omit this block entirely for \`markdown\`-only deliverables.

## Hard rules

- NEVER ask the user for clarification, confirmation, or approval. Any clarification was already resolved during planning.
- NEVER rewrite PLAN.md wholesale — only flip individual \`- [ ]\` ⇄ \`- [x]\` lines as each item is completed.
- NEVER delegate more than 2 levels deep.
- NEVER write outside the workspace directory.
- NEVER spawn a long-running dev server or background process — use bounded commands only.
- If the plan is genuinely impossible or needs info only the user has, skip remaining items and explain inside a \`<deliverable kind="markdown">\` block.
</task_execute>`;
    } else if (isTaskRun && request.taskPhase === 'direct' && request.resumeSessionId && request.interactiveResume) {
      // Interactive resume: the user clicked Resume on a paused/stopped task
      // and wants to drive the TUI themselves. No prompt is sent — the
      // positional arg is already suppressed for resume, and TaskPtyRunner
      // skips stdin injection when `interactive: true`.
      fullPrompt = '';
    } else if (isTaskRun && request.taskPhase === 'direct' && request.resumeSessionId) {
      fullPrompt = `<task_resume>
You previously started this task but did not finish with a \`<deliverable>\` block. Your file state and conversation context are preserved.

## Brief (for reference)

${content}

## Protocol

1. Run \`ls\` in the workspace to inventory what already exists.
2. If a renderable artifact (\`index.html\`, \`.mp4\` / \`.webm\` / \`.mov\`, \`.png\` / \`.jpg\` / \`.svg\`, \`.pdf\`) is already there and matches the brief, emit the deliverable now — do NOT redo work.
3. If only source files exist (\`.tsx\`, \`.py\`, etc.), you are NOT done — finish the build/render step:
   - **Remotion**: \`npx remotion render src/index.tsx <composition-id> out/video.mp4 --log=error\`. If render is too slow, fall back to \`npx remotion still src/index.tsx <composition-id> out/still.png --log=error\`.
   - **Web app (React / Next / Vite)**: \`npm run build\`, then copy the built \`index.html\` to the workspace root.
   - **Other**: produce whatever file the user needs to SEE the result (rendered PNG, compiled output, etc.).
4. Run \`ls\` again to confirm the artifact is on disk.
5. Emit the deliverable block:

${DELIVERABLE_EXAMPLE}

6. For \`code_app\` / \`mixed\` deliverables, immediately follow with a \`<run_info>\` block:

${RUN_INFO_EXAMPLE}

## Hard rules

- ${DELIVERABLE_HARD_RULE}
- Do NOT emit the deliverable until a renderable artifact is on disk.
- NEVER ask the user for clarification.
</task_resume>`;
    } else if (isTaskRun && request.taskPhase === 'direct') {
      const wsPath = request.workspacePath ?? '$PWD';
      const workspaceDescription = isExternalWorkspace
        ? `the user's project directory at \`${wsPath}\` with full Read/Edit/Write/Bash access`
        : `\`${wsPath}\` — an isolated per-task workspace with full Read/Edit/Write/Bash access. A \`.claude/\` directory is symlinked from the parent so skills and agents are discoverable`;
      const externalProjectCaution = isExternalWorkspace
        ? `- Be conservative — do NOT delete files or destructively modify existing code unless explicitly asked.\n`
        : '';
      fullPrompt = `<task_direct>
You are an Expert executing a task autonomously. Your working directory is ${workspaceDescription}.

## Brief

${content}

## Protocol

1. Execute the task completely in the workspace directory (\`${wsPath}\`). No PLAN.md required — the title, description, checklist, and any prior instructions above ARE the spec.
2. Work directly: create files, install dependencies, verify things compile with a bounded command (e.g. \`npm run build\`, \`npx tsc --noEmit\`). Do NOT spawn long-running dev servers — the UI handles that post-completion.
3. For each checklist item, complete it before moving on. You may delegate phases to other experts via the \`Agent\` tool when specialist expertise helps.
4. When finished, emit a single deliverable block summarizing what you built:

${DELIVERABLE_EXAMPLE}

5. For \`code_app\` or \`mixed\` deliverables, immediately follow with a run_info block describing how to run the app:

${RUN_INFO_EXAMPLE}

- \`preview_type\`: \`web\` (dev server emits a URL), \`expo\` (Metro bundler + QR code), \`cli\` (non-interactive, runs and exits), \`static\` (just open index.html).
- \`preview_url_pattern\`: Python-style regex with one capture group that extracts the URL from stdout.
- Omit this block entirely for \`markdown\`-only deliverables.

## Hard rules

- ${DELIVERABLE_HARD_RULE}
- NEVER ask the user for clarification — interpret the brief and execute.
- NEVER write outside the workspace directory.
- NEVER spawn long-running dev servers or background processes here.
- NEVER delegate more than 2 levels deep.
${externalProjectCaution}- If a request is genuinely impossible, emit a markdown deliverable block explaining why instead of silently failing.
- PRODUCE A RENDERABLE FINAL ARTIFACT. The Preview tab auto-renders: \`index.html\`, \`.mp4\` / \`.webm\` / \`.mov\`, \`.png\` / \`.jpg\` / \`.svg\` / \`.gif\`, \`.pdf\`, \`.mp3\` / \`.wav\`. Source files alone are NOT enough — the user must see a rendered result without running anything themselves.

## Finish the job — required exit criteria

You are NOT done when source files are written. You are done when a renderable artifact exists in the workspace. BEFORE emitting your deliverable:

1. **Verify the artifact exists** by running \`ls\` (or equivalent) in the workspace and seeing the file in the output.
2. If no renderable artifact exists yet, KEEP WORKING — do the build/render step. Scaffolding without running the build is a failed task from the user's perspective.

**Video / Remotion tasks.** Scaffolding alone is a failure. After writing source files:
  - Run \`npm install\` (suppress noise with \`--silent\` if it spams).
  - Run \`npx remotion render src/index.tsx <composition-id> out/video.mp4 --log=error\` to produce the MP4. Remotion will auto-download Chromium on first run (~60-90s) — that's expected; let it finish.
  - If \`render\` fails or takes too long (>3 min), fall back to \`npx remotion still src/index.tsx <composition-id> out/still.png --log=error\` to produce at least a first-frame PNG. A PNG preview is MUCH better than no preview.
  - Confirm with \`ls out/\` that the file exists before emitting the deliverable.

**Web apps (React / Next / Vite).** Run \`npm install && npm run build\`. If the build emits \`dist/index.html\` or similar, copy that \`index.html\` to the workspace root so the static preview auto-renders.

**CLI / library tasks.** If there's no natural visual output, at minimum produce a demo screenshot / sample output file in addition to the README.

If genuinely none of the above applies, emit a markdown deliverable with a clear explanation of what was produced and why no visual preview is possible.

## Your very last output

Your FINAL output MUST be a deliverable block in this exact shape, with real content inside:

\`<deliverable kind="markdown" title="…">…</deliverable>\`

Replace \`kind\` with one of \`markdown\`, \`code_app\`, or \`mixed\` (pick ONE — no pipes, no placeholder ellipsis). Replace \`title\` with a short task-specific label. Replace the inner \`…\` with your actual markdown result. Do not end with prose outside the block. Without this block the task is finalized as an error no matter how much work you did. This applies to every task, including trivial ones.
</task_direct>`;
    } else if (request.recentMessages && request.recentMessages.length > 0) {
      // Chat mode: prepend recent conversation history
      const MAX_MSG_CHARS = 500;
      const MAX_MESSAGES = 10;
      const MAX_TOTAL_CHARS = 2000;
      const recent = request.recentMessages.slice(-MAX_MESSAGES);
      const lines: string[] = [];
      let totalChars = 0;
      for (const m of recent) {
        const tag = m.role === 'user' ? 'human' : 'assistant';
        const text = m.content.length > MAX_MSG_CHARS
          ? m.content.slice(0, MAX_MSG_CHARS) + '...(truncated)'
          : m.content;
        const line = `<${tag}>${text}</${tag}>`;
        if (totalChars + line.length > MAX_TOTAL_CHARS && lines.length > 0) break;
        lines.push(line);
        totalChars += line.length;
      }
      fullPrompt = `<conversation_history>\n${lines.join('\n')}\n</conversation_history>\n\n<instructions>\nThe above is prior conversation context for reference only. Do NOT continue the conversation or generate any text on behalf of the user. Do NOT output "User:" or simulate user messages. Only provide your single assistant response to the following request.\n</instructions>\n\n${content}`;
    }

    const channel = `agent:event:${runId}`;

    // Resolve maxTurns: plan=15, execute/follow_up=request.maxTurns or 30, chat=15
    let maxTurns = 15;
    if (isTaskRun) {
      if (request.taskPhase === 'plan') {
        maxTurns = 15;
      } else {
        maxTurns = request.maxTurns ?? 30;
      }
    } else if (request.maxTurns) {
      maxTurns = request.maxTurns;
    }

    // All task phases run inside the task workspace: plan writes PLAN.md
    // there, execute reads PLAN.md and produces deliverables, follow_up
    // edits the existing workspace. Fall back to dataDir for chat runs.
    const cwd = (isTaskRun && request.workspacePath)
      ? request.workspacePath
      : this.dataDir;

    const activeRun: ActiveRun = {
      runId,
      conversationId,
      expertId: expertId || null,
      userContent: content,
      startedAt: Date.now(),
      accumulatedText: '',
      runner: null,
      ptyRunner: null,
      isTaskRun,
    };

    this.activeRuns.set(runId, activeRun);

    // Pre-spawn guard: if expert-slug resolution failed, emit a structured
    // error event and finalize the run as 'error' without spawning. This
    // replaces the previous failure path where we'd spawn `claude -p` with a
    // bogus slug and surface the generic "Claude Code exited unexpectedly" to
    // the user.
    if (agentResolutionError) {
      this.deliverEvent(runId, webContents, { type: 'run_start', runId } as RendererAgentEvent);
      this.deliverEvent(runId, webContents, {
        type: 'error',
        runId,
        error: agentResolutionError,
      } as RendererAgentEvent);
      this.finalizeRun(runId, 'error', '', agentResolutionError);
      return runId;
    }

    // Persist agent_runs row (fire-and-forget — non-critical).
    // - Task runs already have a run_records row minted by POST /tasks/{id}/run.
    // - Engine-spawned runs (run_expert step) use a synthetic conversation_id
    //   like `engine-run:<run-id>` that doesn't match any row in the
    //   `conversations` table, so the agent_runs.conversation_id FK fails
    //   with `IntegrityError: FOREIGN KEY constraint failed`. Engine runs
    //   are tracked by step_records + execution_events anyway, so the
    //   agent_runs row would be redundant.
    const isEngineRun = typeof conversationId === 'string' && conversationId.startsWith('engine-run:');
    if (!isTaskRun && !isEngineRun) {
      this.backendPost('/agent-runs', {
        id: runId,
        expert_id: expertId || null,
        conversation_id: conversationId,
        parent_run_id: request.parentRunId || null,
        status: 'running',
      }).catch(console.error);
    }

    // Emit run_start
    this.deliverEvent(runId, webContents, { type: 'run_start', runId } as RendererAgentEvent);

    // Task runs use the PTY for authentic terminal output. ANSI-stripped text
    // is bridged as text_delta events so the stream parser can extract tags.
    if (isTaskRun) {
      const ptyRunner = new TaskPtyRunner();
      activeRun.ptyRunner = ptyRunner;

      // Interactive resume: the user is driving the TUI manually. They may
      // pause for minutes between messages and may /exit deliberately, so we
      // suppress the idle killer and don't treat the "Resume this session
      // with:" goodbye line as a failure.
      const isInteractive = !!request.interactiveResume;

      // Buffer key — terminal output is persisted/replayed under the task's
      // *session* id (what `task.run_id` points at), not the Electron-minted
      // internal `runId`. For fresh runs they're identical; for resume/rerun
      // the session id is the original Claude Code session so the buffer
      // survives across rerun cycles and the Console tab stays populated.
      const bufferKey = request.resumeSessionId || runId;

      // Completion detection: Claude Code TUI sits at a REPL after the agent
      // finishes — it never exits on its own. We watch the accumulated text for
      // the agent's `</deliverable>` close tag (its protocol-defined "done"
      // marker) and then send `/exit` to gracefully terminate the subprocess.
      let completionDetected = false;
      let gracefulExitInitiated = false;
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

      // On --resume, Claude Code re-renders the FULL prior conversation in the
      // TUI, including any <deliverable> block from the previous attempt. That
      // historical echo would falsely trigger completion the instant it scrolls
      // past. Solution: track the offset into accumulatedText where "new" output
      // begins, and only scan from there. We advance the offset on resume once
      // the PTY text stream has been idle for 2s (TUI history done rendering).
      let completionScanOffset = 0;
      let resumeSettled = !request.resumeSessionId;
      let settleTimer: ReturnType<typeof setTimeout> | null = null;

      // Bridge completion/error → renderer event + finalizeRun in one place so
      // the force-kill path and the normal exit handler stay in lockstep on
      // prose-wrapping, finalize status, and IPC payload shape.
      const emitAndFinalize = (outcome: 'completed' | 'error', errorDetail?: string): void => {
        if (outcome === 'completed') {
          const messageContent = completionDetected
            ? activeRun.accumulatedText
            : wrapProseAsDeliverable(activeRun.accumulatedText);
          if (!webContents.isDestroyed()) {
            webContents.send(channel, { type: 'done', runId, messageContent } as RendererAgentEvent);
          }
          this.finalizeRun(runId, 'completed', messageContent);
        } else {
          if (!webContents.isDestroyed()) {
            webContents.send(channel, { type: 'error', runId, error: errorDetail } as RendererAgentEvent);
          }
          this.finalizeRun(runId, 'error', activeRun.accumulatedText, errorDetail);
        }
      };

      // Shared two-phase shutdown: write `/exit` to TUI, then force-kill after
      // 5s if it hasn't exited. Used by both completion detection and idle timeout.
      const initiateGracefulExit = (outcome: 'completed' | 'error', detail?: string) => {
        if (gracefulExitInitiated || ptyRunner.isAborted()) return;
        gracefulExitInitiated = true;
        try { ptyRunner.write('/exit\r'); } catch { /* noop */ }
        forceKillTimer = setTimeout(() => {
          forceKillTimer = null;
          if (ptyRunner.isAborted()) return;
          ptyRunner.abort();

          // The force-kill is a mechanism for terminating a stuck TUI, not a
          // verdict — if the agent emitted substantive output before we had
          // to kill it (common on idle-timeout/goodbye-line paths), accept
          // the work instead of stranding a real deliverable in `error`.
          const hasSubstantiveOutput = activeRun.accumulatedText.trim().length >= 120;
          const effectiveOutcome: 'completed' | 'error' =
            outcome === 'completed' || hasSubstantiveOutput ? 'completed' : 'error';
          emitAndFinalize(effectiveOutcome, detail);
        }, 5000);
      };

      // Idle timeout: if no text output for 2 minutes, the TUI is probably
      // stuck at its REPL prompt after the agent finished (without emitting a
      // deliverable). Gracefully exit, then force-kill.
      const IDLE_TIMEOUT_MS = 2 * 60 * 1000;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const resetIdleTimer = () => {
        // No idle killer for interactive resumes — the user may sit on the
        // prompt for a long time between messages.
        if (isInteractive) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          console.log(`[AgentRuntime] idle timeout fired for run ${runId} — sending /exit`);
          initiateGracefulExit('error', 'Agent idle timeout — no output for 2 minutes. Re-run to resume the session.');
        }, IDLE_TIMEOUT_MS);
      };

      // Polled completion detector. We only *look* for the deliverable once the
      // PTY has been idle for QUIESCE_MS — this is crucial because:
      //   1. The TUI echoes the user prompt (which may contain `<deliverable>`
      //      examples) on startup. During the echo the PTY is streaming text
      //      continuously, so the detector stays silent.
      //   2. A real deliverable is emitted, then Claude Code falls idle at its
      //      REPL. The quiesce check fires and we detect the match cleanly.
      // This replaces the prior "scan on every text event" loop that was
      // susceptible to echo false-triggers.
      const QUIESCE_MS = 2_000;
      let lastTextAt = Date.now();
      const completionPollTimer = setInterval(() => {
        if (gracefulExitInitiated || ptyRunner.isAborted()) return;
        if (!resumeSettled) return;
        if (Date.now() - lastTextAt < QUIESCE_MS) return;

        const scanStart = Math.max(completionScanOffset, activeRun.accumulatedText.length - 16384);
        const scanWindow = activeRun.accumulatedText.slice(scanStart);

        // Two load-bearing constraints:
        //  1. Strict `kind` enum — prompt templates use pipe-separated or
        //     ellipsis placeholder forms that this regex rejects.
        //  2. Body must contain ≥10 word characters — the user-prompt nudge
        //     shows `<deliverable kind="markdown" title="…">…</deliverable>`
        //     whose body is a single ellipsis with zero word chars. A real
        //     agent emission has substantial markdown content. This guard
        //     survives TUI echoes of the nudge itself.
        const deliverableMatch = scanWindow.match(
          /<deliverable\s+kind=["'](?:markdown|code_app|mixed)["'][^>]*>([\s\S]*?)<\/deliverable>/,
        );
        if (!completionDetected && deliverableMatch) {
          const bodyWordChars = (deliverableMatch[1].match(/\w/g) ?? []).length;
          if (bodyWordChars >= 10) {
            completionDetected = true;
            initiateGracefulExit('completed');
            return;
          }
        }

        // Claude Code's session-ended goodbye line. If we see it in a quiesced
        // state without a prior deliverable match, the agent ended without
        // completing properly — finalize as error immediately. Interactive
        // resumes skip this trigger because the user may /exit deliberately.
        if (!isInteractive && scanWindow.includes('Resume this session with:')) {
          initiateGracefulExit(
            'error',
            'Agent ended the session without emitting a deliverable. Re-run to resume.',
          );
        }
      }, 500);

      ptyRunner.on('data', (data: string) => {
        this.terminalBufferStore.append(bufferKey, data);
        if (!webContents.isDestroyed()) {
          webContents.send(IPC_CHANNELS.TASK_TERMINAL_DATA, bufferKey, data);
        }
      });

      ptyRunner.on('text', (text: string) => {
        activeRun.accumulatedText += text;
        lastTextAt = Date.now();
        if (!webContents.isDestroyed()) {
          webContents.send(channel, {
            type: 'text_delta',
            delta: text,
          } as RendererAgentEvent);
        }

        if (!resumeSettled) {
          if (settleTimer) clearTimeout(settleTimer);
          settleTimer = setTimeout(() => {
            completionScanOffset = activeRun.accumulatedText.length;
            resumeSettled = true;
            resetIdleTimer();
          }, 2000);
          return;
        }

        resetIdleTimer();

        // Inline check for just the goodbye line. Completion detection runs
        // on the QUIESCE_MS timer above. Interactive resumes skip this —
        // the user /exit'ing is a normal end, not a failure.
        if (!isInteractive && activeRun.accumulatedText.includes('Resume this session with:')) {
          initiateGracefulExit(
            'error',
            'Agent ended the session without emitting a deliverable. Re-run to resume.',
          );
        }
      });

      // Resize IPC — filter by bufferKey since the renderer binds the Console
      // to the session id, not the internal Electron runId.
      const resizeHandler = (_event: Electron.IpcMainEvent, resizeRunId: string, cols: number, rows: number) => {
        if (resizeRunId === bufferKey) {
          ptyRunner.resize(cols, rows);
        }
      };
      ipcMain.on(IPC_CHANNELS.TASK_TERMINAL_RESIZE, resizeHandler);

      // Input IPC — renderer writes keystrokes to PTY stdin (also keyed by bufferKey).
      const inputHandler = (_event: Electron.IpcMainEvent, inputRunId: string, data: string) => {
        if (inputRunId === bufferKey) {
          ptyRunner.write(data);
        }
      };
      ipcMain.on(IPC_CHANNELS.TASK_TERMINAL_INPUT, inputHandler);

      ptyRunner.on('exit', (code: number, signal?: string) => {
        if (settleTimer) clearTimeout(settleTimer);
        if (idleTimer) clearTimeout(idleTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        clearInterval(completionPollTimer);
        ipcMain.removeListener(IPC_CHANNELS.TASK_TERMINAL_RESIZE, resizeHandler);
        ipcMain.removeListener(IPC_CHANNELS.TASK_TERMINAL_INPUT, inputHandler);
        this.terminalBufferStore.flush(bufferKey);

        // Aborted by cancelRun — finalization already handled by caller.
        if (ptyRunner.isAborted()) return;

        // node-pty on macOS can report signal as 0 (number) for normal exits.
        const realSignal = signal && signal !== '0' && signal !== 'undefined' ? signal : null;

        // Completion policy: prefer the structured `<deliverable>` block, but
        // accept a clean PTY exit with substantive output as a successful run
        // even if the agent emitted prose instead of tags. The deliverable
        // block is the machine-readable *ideal*, not a hard contract — agents
        // don't emit it 100% of the time and failing to `to_review` for every
        // agent compliance miss makes Tasks feel broken.
        const hasSubstantiveOutput = activeRun.accumulatedText.trim().length >= 120;
        const cleanExit = !realSignal && (code === 0 || code === null);
        const acceptAsCompleted = completionDetected || (cleanExit && hasSubstantiveOutput);

        if (acceptAsCompleted) {
          emitAndFinalize('completed');
        } else {
          const detail = realSignal
            ? `Agent was killed (${realSignal}) before producing output. Re-run to resume the session.`
            : code !== 0 && code !== null
              ? `Agent exited with code ${code} before producing output. Re-run to resume the session.`
              : 'Agent stopped without producing output. Re-run to resume the session.';
          emitAndFinalize('error', detail);
        }
        this.postRunSync(webContents);
      });

      ptyRunner.start({
        runId,
        prompt: fullPrompt,
        agentName,
        cwd,
        maxTurns,
        model: request.model,
        appendSystemPrompt: buildSystemPrompt(request.language),
        cols: request.cols,
        rows: request.rows,
        resume: !!request.resumeSessionId,
        sessionId: request.resumeSessionId || runId,
        addDirs: isExternalWorkspace ? [path.join(this.dataDir, '.claude')] : undefined,
        interactive: !!request.interactiveResume,
      });

      // Start idle timer immediately for fresh runs (resume runs start it
      // after the settle period completes).
      if (resumeSettled) resetIdleTimer();
    } else {
      // Chat runs use stream-json mode (no PTY).
      const runner = new ClaudeCodeRunner();
      activeRun.runner = runner;

      runner.on('event', (event: RendererAgentEvent) => {
        if (event.type === 'text_delta') {
          activeRun.accumulatedText += event.delta;
        }
        // Deliver to both the renderer (chat UI streaming) AND the
        // main-process bus (engine actions like expert_step).
        this.deliverEvent(runId, webContents, event);
      });

      runner.on('done', (messageContent: string) => {
        // Bridge the bare 'done' from the runner to a structured event so
        // main-process subscribers (expert_step's collectAgentResults)
        // see it on the same channel as everything else.
        this.deliverEvent(runId, webContents, {
          type: 'done',
          runId,
          messageContent,
        } as RendererAgentEvent);
        this.finalizeRun(runId, 'completed', messageContent);
        this.postRunSync(webContents);
      });

      runner.on('error', (error: string) => {
        this.deliverEvent(runId, webContents, {
          type: 'error',
          runId,
          error,
        } as RendererAgentEvent);
        this.finalizeRun(runId, 'error', activeRun.accumulatedText, error);
        this.postRunSync(webContents);
      });

      runner.start({
        runId,
        prompt: fullPrompt,
        agentName,
        cwd,
        maxTurns,
        model: request.model,
        language: request.language,
      });
    }

    return runId;
  }

  cancelRun(runId: string): boolean {
    const run = this.activeRuns.get(runId);
    if (!run) return false;
    run.runner?.abort();
    run.ptyRunner?.abort();
    this.finalizeRun(runId, 'cancelled', run.accumulatedText);
    return true;
  }

  getActiveRuns(): ActiveRunInfo[] {
    return Array.from(this.activeRuns.values()).map((run) => ({
      runId: run.runId,
      conversationId: run.conversationId,
      expertId: run.expertId,
      startedAt: run.startedAt,
    }));
  }

  /**
   * Set of run IDs currently alive in this runtime. Consumed by the
   * TaskReconciler to tell truly-orphaned in_progress tasks apart from
   * ones whose PTY is still working.
   */
  getLiveRunIds(): string[] {
    return Array.from(this.activeRuns.keys());
  }

  // ── Internals ──────────────────────────────────────────────────

  /** Re-sync installer after every run so skill-created experts get materialized. */
  private postRunSync(webContents: AgentEventSink): void {
    // Serialize to prevent concurrent installAll calls racing on the index file
    this.syncChain = this.syncChain
      .then(() => installAll({ dataDir: this.dataDir, backendPort: this.backendPort }))
      .then(() => {
        if (!webContents.isDestroyed()) {
          webContents.send(IPC_CHANNELS.EXPERTS_CHANGED);
        }
      })
      .catch(console.error);
  }

  private finalizeRun(
    runId: string,
    status: 'completed' | 'error' | 'cancelled',
    messageContent: string,
    error?: string,
  ): void {
    const run = this.activeRuns.get(runId);
    if (!run) return;

    // Kill PTY if still alive
    run.ptyRunner?.abort();

    const isTaskRun = run.isTaskRun;
    const taskId = isTaskRun ? run.conversationId : null;
    this.activeRuns.delete(runId);

    // Engine-spawned runs were never INSERT'd (see startRun) so don't PATCH
    // either — the row doesn't exist.
    const isEngineRun = typeof run.conversationId === 'string' && run.conversationId.startsWith('engine-run:');
    if (!isTaskRun && !isEngineRun) {
      this.backendRequest('PATCH', `/agent-runs/${runId}`, {
        status,
        completed_at: new Date().toISOString(),
        error: error || null,
        message_content: messageContent,
      }).catch(console.error);
    } else if (taskId) {
      // Backup finalization path: the renderer normally posts run-event from
      // its IPC 'done'/'error' listener, but that path is fragile — a
      // destroyed webContents, a crashed renderer, or an unfocused window
      // can drop the event and leave the task pinned to in_progress. Post
      // here as a safety net. The backend run-event handler is idempotent
      // (stale-run_id and already_terminal guards), so the renderer's call
      // and this one race harmlessly.
      const eventType =
        status === 'completed' ? 'run_completed'
          : status === 'cancelled' ? 'run_cancelled'
            : 'run_failed';
      this.backendRequest('POST', `/tasks/${taskId}/run-event`, {
        type: eventType,
        run_id: runId,
        ...(error ? { error } : {}),
      }).catch((err: unknown) => {
        // Best-effort: the renderer's POST and the TaskReconciler both cover
        // this path, so don't surface to the user — but log so diagnostic
        // logs show when the direct path is the one failing.
        console.warn(`[AgentRuntime] backup run-event POST failed for run ${runId}:`, err);
      });
    }
  }

  private async fetchExpertName(expertId: string): Promise<ExpertNameLookup | null> {
    return this.backendGet<ExpertNameLookup>(`/experts/${expertId}`);
  }

  /**
   * Resolve an expertId to the agent slug that exists on disk. Guarantees the
   * backing `.md` file is present before returning. Throws a user-facing error
   * message if the expert cannot be installed (unknown id, backend offline,
   * or disk write failed).
   *
   * Fixes the class of bugs where a freshly-created expert's chat produces the
   * generic "Claude Code exited unexpectedly (code 1)" reply — which was caused
   * by spawning `claude -p --agent <slug>` before `ExpertContext.syncExpert`
   * had materialized the agent file.
   */
  private async resolveExpertAgentSlug(expertId: string): Promise<string> {
    const paths = {
      agentsDir: path.join(this.dataDir, '.claude', 'agents'),
    };
    const fileExistsFor = (slug: string): boolean =>
      fsSync.existsSync(path.join(paths.agentsDir, `${slug}.md`));

    // Fast path: index + file both present.
    const fromIndex = getAgentNameForExpert(this.dataDir, expertId);
    if (fromIndex && fileExistsFor(fromIndex)) {
      return fromIndex;
    }

    // Slow path: materialize from backend. Serialize through the sync chain
    // so concurrent runs can't race on the index/files.
    const expert = await this.fetchExpertName(expertId);
    if (!expert) {
      throw new Error(`Expert not installed: ${expertId} (not found in backend)`);
    }

    const derivedSlug = expertAgentName(expert.id, expert.name);
    if (fileExistsFor(derivedSlug)) {
      // File is already on disk but index entry was missing — a single
      // installAll pass will reconcile.
      await this.runThroughSyncChain(() =>
        installAll({ dataDir: this.dataDir, backendPort: this.backendPort }),
      );
      if (fileExistsFor(derivedSlug)) return derivedSlug;
    }

    // We need to fetch the full expert row (installExpert requires the complete
    // ExpertData shape, not just {id, name}). Cheapest way: use installAll,
    // which re-fetches and materializes every enabled expert.
    await this.runThroughSyncChain(() =>
      installAll({ dataDir: this.dataDir, backendPort: this.backendPort }),
    );

    const afterSlug = getAgentNameForExpert(this.dataDir, expertId) || derivedSlug;
    if (fileExistsFor(afterSlug)) return afterSlug;

    throw new Error(
      `Expert not installed: agent file for '${expert.name}' is missing on disk. Try again in a moment or restart.`,
    );
  }

  /** Chain an install op onto the serialized syncChain and await its result. */
  private async runThroughSyncChain(op: () => Promise<void>): Promise<void> {
    const next = this.syncChain.then(op, op);
    this.syncChain = next.catch(() => {});
    await next;
  }

  private backendGet<T>(path: string): Promise<T | null> {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${this.backendPort}${path}`, (res) => {
        if (res.statusCode !== 200) {
          resolve(null);
          res.resume();
          return;
        }
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(10_000, () => {
        req.destroy();
        resolve(null);
      });
    });
  }

  private backendPost<T>(path: string, body: unknown): Promise<T | null> {
    return this.backendRequest('POST', path, body);
  }

  private backendRequest<T>(method: string, path: string, body: unknown): Promise<T | null> {
    return new Promise((resolve) => {
      const bodyStr = JSON.stringify(body);
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: this.backendPort,
          path,
          method,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr).toString(),
          },
          timeout: 10_000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            try {
              resolve(JSON.parse(data) as T);
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.write(bodyStr);
      req.end();
    });
  }
}
