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
import { getAgentNameForExpert, installAll } from '../claude-code/installer';
import { IPC_CHANNELS } from '../types/ipc';
import { buildSystemPrompt } from '../i18n/language-directive';

/** Cap concurrent runs to prevent spawning a wall of subprocesses. */
const MAX_CONCURRENT_RUNS = 5;

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

  constructor(backendPort: number, dataDir: string) {
    this.backendPort = backendPort;
    this.dataDir = dataDir;
    this.terminalBufferStore = new TerminalBufferStore(dataDir);
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
    // when no expert is specified. For experts, look up the slug from the
    // installer's sidecar index — if it's not there yet, fall back to a
    // backend fetch + re-derive (covers a freshly-created expert before
    // the next sync).
    let agentName = 'cerebro';
    if (expertId) {
      const fromIndex = getAgentNameForExpert(this.dataDir, expertId);
      if (fromIndex) {
        agentName = fromIndex;
      } else {
        const expert = await this.fetchExpertName(expertId);
        if (!expert) {
          throw new Error(`Expert ${expertId} not found`);
        }
        // Re-derive (matches expertAgentName) — falls through to the next sync
        // pass to actually write the file. If the file is missing, Claude Code
        // will error out and we surface that to the user.
        const { expertAgentName } = await import('../claude-code/installer');
        agentName = expertAgentName(expert.id, expert.name);
      }
    }

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
      fullPrompt = `<task_follow_up>
You are operating in AUTONOMOUS TASK MODE — this is a FOLLOW-UP run on a previously completed task. The user wants you to modify, extend, or redo part of the output.

Your working directory is the same isolated per-task workspace at $PWD. It contains all files from the previous run(s). You have full Read/Edit/Write/Bash access inside it.

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

5. After all changes, emit a new \`<deliverable>\` block with the COMPLETE updated deliverable (not just the diff — the full final version). For code_app, also emit an updated \`<run_info>\` block if the run command changed.

## Hard rules

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

<deliverable kind="markdown|code_app|mixed" title="Short title">
# Heading

Full markdown body here. For code_app, include: overview, file structure, setup commands, run command, notes. This is what the user sees in the Deliverable tab.
</deliverable>

### 6. For code_app or mixed: emit run info
Immediately after the \`<deliverable>\` block, emit exactly one \`<run_info>\` block describing how to run the app. The UI uses this to wire the "Start dev server" button.

<run_info>
{
  "preview_type": "web|expo|cli|static",
  "setup_commands": ["npm install"],
  "start_command": "npm run dev",
  "preview_url_pattern": "Local:\\\\s+(https?://\\\\S+)",
  "notes": "Scan the QR code with Expo Go on your phone."
}
</run_info>

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

    // Persist agent_runs row (fire-and-forget — non-critical).
    // For task runs the run_records row is already minted by POST /tasks/{id}/run,
    // so we skip creating a duplicate.
    if (!isTaskRun) {
      this.backendPost('/agent-runs', {
        id: runId,
        expert_id: expertId || null,
        conversation_id: conversationId,
        parent_run_id: request.parentRunId || null,
        status: 'running',
      }).catch(console.error);
    }

    // Emit run_start
    if (!webContents.isDestroyed()) {
      webContents.send(channel, { type: 'run_start', runId } as RendererAgentEvent);
    }

    // Task runs use the PTY for authentic terminal output. ANSI-stripped text
    // is bridged as text_delta events so the stream parser can extract tags.
    if (isTaskRun) {
      const ptyRunner = new TaskPtyRunner();
      activeRun.ptyRunner = ptyRunner;

      // Raw PTY data → global channel + disk (survives app restart).
      ptyRunner.on('data', (data: string) => {
        this.terminalBufferStore.append(runId, data);
        if (!webContents.isDestroyed()) {
          webContents.send(IPC_CHANNELS.TASK_TERMINAL_DATA, runId, data);
        }
      });

      // ANSI-stripped text → text_delta events for the stream parser
      // (Plan/Deliverable tabs extract structured tags from this text)
      ptyRunner.on('text', (text: string) => {
        activeRun.accumulatedText += text;
        if (!webContents.isDestroyed()) {
          webContents.send(channel, {
            type: 'text_delta',
            delta: text,
          } as RendererAgentEvent);
        }
      });

      // Resize IPC
      const resizeHandler = (_event: Electron.IpcMainEvent, resizeRunId: string, cols: number, rows: number) => {
        if (resizeRunId === runId) {
          ptyRunner.resize(cols, rows);
        }
      };
      ipcMain.on(IPC_CHANNELS.TASK_TERMINAL_RESIZE, resizeHandler);

      // Input IPC — renderer writes keystrokes to PTY stdin
      const inputHandler = (_event: Electron.IpcMainEvent, inputRunId: string, data: string) => {
        if (inputRunId === runId) {
          ptyRunner.write(data);
        }
      };
      ipcMain.on(IPC_CHANNELS.TASK_TERMINAL_INPUT, inputHandler);

      ptyRunner.on('exit', (code: number, signal?: string) => {
        ipcMain.removeListener(IPC_CHANNELS.TASK_TERMINAL_RESIZE, resizeHandler);
        ipcMain.removeListener(IPC_CHANNELS.TASK_TERMINAL_INPUT, inputHandler);
        this.terminalBufferStore.flush(runId);

        // Aborted by cancelRun — finalization already handled by caller.
        if (ptyRunner.isAborted()) return;

        // node-pty on macOS can report signal as 0 (number) for normal exits.
        const realSignal = signal && signal !== '0' && signal !== 'undefined' ? signal : null;
        const isError = (code !== 0 && code !== null) || realSignal != null;
        if (isError) {
          const detail = realSignal
            ? `Claude Code was killed (${realSignal})`
            : `Claude Code exited with code ${code}`;
          if (!webContents.isDestroyed()) {
            webContents.send(channel, { type: 'error', runId, error: detail } as RendererAgentEvent);
          }
          this.finalizeRun(runId, 'error', activeRun.accumulatedText, detail);
        } else {
          if (!webContents.isDestroyed()) {
            webContents.send(channel, {
              type: 'done',
              runId,
              messageContent: activeRun.accumulatedText,
            } as RendererAgentEvent);
          }
          this.finalizeRun(runId, 'completed', activeRun.accumulatedText);
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
      });
    } else {
      // Chat runs use stream-json mode (no PTY).
      const runner = new ClaudeCodeRunner();
      activeRun.runner = runner;

      runner.on('event', (event: RendererAgentEvent) => {
        if (event.type === 'text_delta') {
          activeRun.accumulatedText += event.delta;
        }
        if (!webContents.isDestroyed()) {
          webContents.send(channel, event);
        }
      });

      runner.on('done', (messageContent: string) => {
        this.finalizeRun(runId, 'completed', messageContent);
        this.postRunSync(webContents);
      });

      runner.on('error', (error: string) => {
        if (!webContents.isDestroyed()) {
          webContents.send(channel, {
            type: 'error',
            runId,
            error,
          } as RendererAgentEvent);
        }
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
    this.activeRuns.delete(runId);

    // For task runs the renderer handles finalization via POST /tasks/{id}/finalize.
    // Only persist agent_runs for chat runs.
    if (!isTaskRun) {
      this.backendRequest('PATCH', `/agent-runs/${runId}`, {
        status,
        completed_at: new Date().toISOString(),
        error: error || null,
        message_content: messageContent,
      }).catch(console.error);
    }
  }

  private async fetchExpertName(expertId: string): Promise<ExpertNameLookup | null> {
    return this.backendGet<ExpertNameLookup>(`/experts/${expertId}`);
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
