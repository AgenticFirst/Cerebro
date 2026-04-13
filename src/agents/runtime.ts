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
import { ipcMain, type WebContents } from 'electron';
import type { AgentRunRequest, ActiveRunInfo, RendererAgentEvent } from './types';
import { ClaudeCodeRunner } from '../claude-code/stream-adapter';
import { TaskPtyRunner } from '../pty/TaskPtyRunner';
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
  runner: ClaudeCodeRunner;
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

  constructor(backendPort: number, dataDir: string) {
    this.backendPort = backendPort;
    this.dataDir = dataDir;
  }

  /**
   * Spawn a Claude Code subprocess for one chat turn.
   * Returns the runId immediately; events stream over `agent:event:<runId>`.
   */
  async startRun(
    webContents: WebContents,
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

    if (isTaskRun && request.taskPhase === 'clarify') {
      const maxQ = request.maxClarifyQuestions ?? 5;
      fullPrompt = `<task_clarify>
You are Cerebro preparing to execute an autonomous task. This is a SHORT preparation pass — you will not execute anything here. Your only job is to decide whether you need clarification from the user before the real execution run begins.

## Decision tree

1. Read the goal.
2. Ask yourself: do I have enough to produce a good result, or am I likely to waste turns making wrong assumptions about style, scope, target users, or technical choices?
3. If you have enough: emit exactly \`<ready/>\` and stop. Do not output anything else.
4. If you do not: emit 1–${maxQ} questions in this exact format and stop. Each question must meaningfully change what you build.

<clarification>
{"questions":[
  {"id":"q1","kind":"text","q":"What's the primary use case you want to nail?","placeholder":"e.g. logging my workouts while at the gym"},
  {"id":"q2","kind":"select","q":"Which platform?","options":["iOS","Android","Both (Expo)","Web"],"default":"Both (Expo)"},
  {"id":"q3","kind":"select","q":"Visual style?","options":["Minimal / dark","Playful / colorful","Professional / clean"],"default":"Minimal / dark"},
  {"id":"q4","kind":"bool","q":"Include mock data so it feels real on first launch?","default":true}
]}
</clarification>

## Rules

- Maximum ${maxQ} questions. Three is usually plenty.
- Every question must be answerable in a few seconds — no essays.
- \`kind\` is one of: \`text\`, \`select\` (requires \`options\`), \`bool\`.
- Do NOT ask about things you should decide yourself (framework choice, file structure, which expert to use). Ask only about what the user would actually have an opinion on.
- Do NOT ask about things already specified in the goal.
- If the goal is clearly a one-shot ("write a haiku about oceans", "summarize this article"), emit \`<ready/>\` — no questions.
- Do NOT call any tools. Do NOT use Agent, Bash, Read, Write. Output is JSON inside tags, nothing else.

## Goal

${content}
</task_clarify>`;
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
      const maxPhases = request.maxPhases ?? 6;
      const answersSection = request.clarificationAnswers
        ? `\n## User's answers to clarifying questions\n${request.clarificationAnswers}\n`
        : '';
      fullPrompt = `<task_execute>
You are operating in AUTONOMOUS TASK MODE for a high-level goal from the user. Your working directory is an isolated per-task workspace at $PWD. You have full Read/Edit/Write/Bash access inside it.

## Workspace

- You are currently cd'd into the task workspace (\`${request.workspacePath ?? '$PWD'}\`).
- Anything you write here is persisted and owned by the task. The user will browse it in the Deliverable tab.
- Use this workspace for ALL file output. Do not write outside it.
- \`.claude/\` is symlinked from the parent so skills and agents are still discovered.

## Protocol (follow in order)

### 1. Read the roster
Run the \`list-experts\` skill (via Bash) to see which specialists are available.

### 2. Plan
Decompose the goal into 2–${maxPhases} sequential phases. Decide the **deliverable kind** — one of:
- \`markdown\` — a standalone markdown artifact (spec, brief, plan, outline).
- \`code_app\` — an actual runnable project on disk in the workspace.
- \`mixed\` — both a markdown doc and a code project.

For each phase decide:
- a short name,
- a one-sentence description of what "done" looks like,
- which existing expert should execute it (by slug from the roster),
- or, if no existing expert fits, what new expert you will create.

Emit your plan in this exact format before doing anything else:

<plan kind="markdown|code_app|mixed">
{"phases":[
  {"id":"p1","name":"…","description":"…","expert_slug":"existing-slug","needs_new_expert":false},
  {"id":"p2","name":"…","description":"…","expert_slug":null,"needs_new_expert":true,"new_expert":{"name":"…","description":"…","domain":"…"}}
]}
</plan>

Keep it tight. Merge phases aggressively.

### 3. Hire missing experts
For each phase with \`needs_new_expert: true\`, invoke the \`create-expert\` skill IMMEDIATELY and without user confirmation. Generate a sensible \`name\`, \`description\`, \`system_prompt\`, and \`domain\` yourself. Run the bash command directly — do NOT stop to ask the user. After SUCCESS, run \`bash "$CLAUDE_PROJECT_DIR/.claude/scripts/rematerialize-experts.sh"\` to make the new expert invocable in this same run.

### 4. Execute phases
For each phase in order:
1. Emit \`<phase id="pN" name="...">\` on its own line.
2. Use the \`Agent\` tool to delegate to the assigned expert. Pass the phase description plus any context from prior phases. When delegating for a code phase, tell the subagent the workspace path so they write files in the right place.
3. When the Agent tool returns, emit \`<phase_summary>one-line summary of what was delivered</phase_summary>\`.
4. Emit \`</phase>\` on its own line.

If a phase fails or returns something unusable, note it briefly and continue — do not retry more than once. A partial deliverable is better than a stuck task.

### 5. For code_app or mixed: smoke-test the build
Before synthesis, run a bounded verification command in the workspace (e.g. \`npm install\` + \`npm run build\` for web, \`npx tsc --noEmit\` for TS, \`python -m py_compile\` for Python, \`npx expo-doctor\` for Expo). If it fails, have at most one fix-up pass: spawn the relevant expert again with the error output. Do NOT start long-running dev servers here — the UI spawns those post-completion.

### 6. Synthesize
Emit the final deliverable block. For \`markdown\`: a standalone markdown artifact. For \`code_app\`: a README-style summary of what was built, structure, and how to run it. For \`mixed\`: both in one block.

<deliverable kind="markdown|code_app|mixed" title="Short title">
# Heading

Full markdown body here. For code_app, include: overview, file structure, setup commands, run command, notes. This is what the user sees in the Deliverable tab.
</deliverable>

### 7. For code_app or mixed: emit run info
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
- \`preview_url_pattern\`: Python-style regex with one capture group that extracts the URL from stdout. For Expo, use \`exp://(\\\\S+)\` or the Metro URL.
- Omit this block entirely for \`markdown\`-only deliverables.

## Hard rules

- NEVER ask the user for clarification, confirmation, or approval. Any clarification was already resolved upstream.
- NEVER output text between phase markers except tool calls; save narration for \`<phase_summary>\` and the final deliverable.
- NEVER create more than ${maxPhases} phases.
- NEVER delegate more than 2 levels deep (your subagents may delegate once; their subagents may not).
- NEVER write outside the workspace directory.
- NEVER spawn a long-running dev server or background process — use bounded commands only.
- If the goal is genuinely impossible or needs info only the user has, skip phases and explain inside a \`<deliverable kind="markdown">\` block.

## Goal

${content}
${answersSection}
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
    const runner = new ClaudeCodeRunner();

    const activeRun: ActiveRun = {
      runId,
      conversationId,
      expertId: expertId || null,
      userContent: content,
      startedAt: Date.now(),
      accumulatedText: '',
      runner,
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

    // Forward stream events to renderer
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

    // Resolve maxTurns: clarify=5, execute/follow_up=request.maxTurns or 60, chat=15
    let maxTurns = 15;
    if (isTaskRun) {
      if (request.taskPhase === 'clarify') {
        maxTurns = 5;
      } else {
        maxTurns = request.maxTurns ?? 60;
      }
    } else if (request.maxTurns) {
      maxTurns = request.maxTurns;
    }

    // For task execute/follow_up phases, use the workspace as CWD so Claude
    // Code writes files there. For everything else, use dataDir.
    const cwd = (isTaskRun && (request.taskPhase === 'execute' || request.taskPhase === 'follow_up') && request.workspacePath)
      ? request.workspacePath
      : this.dataDir;

    runner.start({
      runId,
      prompt: fullPrompt,
      agentName,
      cwd,
      maxTurns,
      model: request.model,
      language: request.language,
    });

    // For task execute/follow_up, also spawn a PTY runner for authentic terminal
    // output. The PTY data goes directly to the renderer for xterm.js display.
    // The stream-json runner above still handles structured events for the
    // Plan/Deliverable tabs.
    if (isTaskRun && request.taskPhase !== 'clarify') {
      const ptyRunner = new TaskPtyRunner();
      activeRun.ptyRunner = ptyRunner;

      const ptyChannel = IPC_CHANNELS.taskTerminalData(runId);

      ptyRunner.on('data', (data: string) => {
        if (!webContents.isDestroyed()) {
          webContents.send(ptyChannel, data);
        }
      });

      // Listen for resize requests from the renderer
      const resizeHandler = (_event: Electron.IpcMainEvent, resizeRunId: string, cols: number, rows: number) => {
        if (resizeRunId === runId) {
          ptyRunner.resize(cols, rows);
        }
      };
      ipcMain.on(IPC_CHANNELS.TASK_TERMINAL_RESIZE, resizeHandler);

      ptyRunner.on('exit', () => {
        ipcMain.removeListener(IPC_CHANNELS.TASK_TERMINAL_RESIZE, resizeHandler);
      });

      ptyRunner.start({
        runId,
        prompt: fullPrompt,
        agentName,
        cwd,
        maxTurns,
        model: request.model,
        appendSystemPrompt: buildSystemPrompt(request.language),
      });
    }

    return runId;
  }

  cancelRun(runId: string): boolean {
    const run = this.activeRuns.get(runId);
    if (!run) return false;
    run.runner.abort();
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
  private postRunSync(webContents: WebContents): void {
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
