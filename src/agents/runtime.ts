/**
 * AgentRuntime — manages concurrent Agent instances.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import type { WebContents } from 'electron';
import type { Agent, AgentEvent } from '@mariozechner/pi-agent-core';
import type { AgentRunRequest, ActiveRunInfo, RendererAgentEvent, ExpertModelConfig, SubAgentResult, ResolvedModel } from './types';
import type { ExecutionEngine } from '../engine/engine';
import { resolveModel } from './model-resolver';
import { createToolsForExpert } from './tools';
import { createExpertAgent } from './create-agent';
import { translateEvent } from './events';
import { createEnhancedAgentConfig, createTurnGovernor, classifyModelTier } from './loop';
import { createAgentLogger } from './logger';
import { OrchestrationTracker } from './orchestration-tracker';
import { ClaudeCodeRunner } from '../claude-code/stream-adapter';
import { createMcpBridge, cleanupMcpBridge, type McpBridgeFiles } from '../claude-code/mcp-bridge';

/** Cap concurrent agents to prevent resource exhaustion (each run holds an HTTP stream + tools). */
const MAX_CONCURRENT_RUNS = 5;

interface ActiveRun {
  runId: string;
  conversationId: string;
  expertId: string | null;
  userContent: string;
  agent: Agent | null;
  unsubscribe: () => void;
  governorUnsub: (() => void) | null;
  startedAt: number;
  accumulatedText: string;
  tracker: OrchestrationTracker;
  claudeCodeRunner?: ClaudeCodeRunner;
  mcpBridge?: McpBridgeFiles;
}

interface ExpertData {
  id: string;
  system_prompt: string | null;
  model_config_json: string | null;
  tool_access: string | null;
  max_turns: number;
  token_budget: number;
}

export class AgentRuntime {
  private activeRuns = new Map<string, ActiveRun>();
  private runCompletions = new Map<string, {
    resolve: (result: SubAgentResult) => void;
    reject: (error: Error) => void;
  }>();
  /** Cache for results that arrived before waitForCompletion was called. */
  private completedResults = new Map<string, SubAgentResult>();
  private backendPort: number;
  private executionEngine: ExecutionEngine | null = null;

  constructor(backendPort: number) {
    this.backendPort = backendPort;
  }

  setExecutionEngine(engine: ExecutionEngine): void {
    this.executionEngine = engine;
  }

  /**
   * Wait for a run to complete. Used by delegation tools to wait for sub-agent results.
   */
  waitForCompletion(runId: string, timeoutMs = 120_000): Promise<SubAgentResult> {
    return new Promise<SubAgentResult>((resolve, reject) => {
      // Check the completed results cache first (run finished before we started waiting)
      const cached = this.completedResults.get(runId);
      if (cached) {
        this.completedResults.delete(runId);
        resolve(cached);
        return;
      }

      // Register the waiter
      this.runCompletions.set(runId, { resolve, reject });

      // TOCTOU double-check: result may have arrived between the cache check and
      // the waiter registration above
      const cachedAfter = this.completedResults.get(runId);
      if (cachedAfter) {
        this.completedResults.delete(runId);
        this.runCompletions.delete(runId);
        resolve(cachedAfter);
        return;
      }

      // Timeout guard
      const timer = setTimeout(() => {
        this.runCompletions.delete(runId);
        reject(new Error(`Delegation timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // Clean up timer when resolved/rejected
      const original = this.runCompletions.get(runId)!;
      this.runCompletions.set(runId, {
        resolve: (result) => {
          clearTimeout(timer);
          original.resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          original.reject(err);
        },
      });
    });
  }

  async startRun(
    webContents: WebContents,
    request: AgentRunRequest,
  ): Promise<string> {
    if (this.activeRuns.size >= MAX_CONCURRENT_RUNS) {
      throw new Error('Too many concurrent agent runs');
    }

    const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
    const { conversationId, content, expertId } = request;

    // Fetch expert config if specified
    let expertData: ExpertData | null = null;
    if (expertId) {
      expertData = await this.fetchExpert(expertId);
    }

    // Parse model config
    let expertModelConfig: ExpertModelConfig | null = null;
    if (expertData?.model_config_json) {
      try {
        expertModelConfig = JSON.parse(expertData.model_config_json);
      } catch {
        // Invalid JSON, use default
      }
    }

    // Resolve model — throw so the renderer catch block can show a modal
    const resolvedModel = await resolveModel(expertModelConfig, this.backendPort);
    if (!resolvedModel) {
      throw new Error('No model is currently available. Go to Integrations to configure a model.');
    }

    // Classify model tier early (used for memory recall limits and enhanced loop)
    const tier = classifyModelTier(resolvedModel);
    const isClaudeCode = resolvedModel.source === 'claude-code';

    // Fetch memory-assembled system prompt
    let systemPrompt = expertData?.system_prompt || '';
    try {
      const scope = expertId ? 'expert' : 'personal';
      const scopeId = expertId || null;
      const isPersonalScope = scope === 'personal';
      const memoryRes = await this.backendPost<{ system_prompt: string }>(
        '/memory/context',
        {
          messages: [{ role: 'user', content }],
          scope,
          scope_id: scopeId,
          include_expert_catalog: isPersonalScope,
          include_routine_catalog: isPersonalScope,
          model_tier: tier,
          is_claude_code: isClaudeCode,
        },
      );
      if (memoryRes?.system_prompt) {
        systemPrompt = memoryRes.system_prompt;
      }
    } catch {
      // Memory is non-critical
    }

    // Inject recent conversation history so the LLM has multi-turn context.
    // Cap at 10 most recent messages and 2000 total chars to bound prompt size.
    if (request.recentMessages && request.recentMessages.length > 0) {
      const MAX_MSG_CHARS = 500;
      const MAX_MESSAGES = 10;
      const MAX_TOTAL_CHARS = 2000;
      const recent = request.recentMessages.slice(-MAX_MESSAGES);
      const lines: string[] = [];
      let totalChars = 0;
      for (const m of recent) {
        const tag = m.role === 'user' ? 'user' : 'assistant';
        const text = m.content.length > MAX_MSG_CHARS
          ? m.content.slice(0, MAX_MSG_CHARS) + '...(truncated)'
          : m.content;
        const line = `<${tag}>${text}</${tag}>`;
        if (totalChars + line.length > MAX_TOTAL_CHARS && lines.length > 0) break;
        lines.push(line);
        totalChars += line.length;
      }
      const transcript = lines.join('\n');
      systemPrompt += `\n\n## Recent Conversation History\nThe following is the recent conversation with the user. Use this context to understand follow-ups, avoid repeating yourself, and maintain conversational continuity.\n\n${transcript}`;
    }

    // Inject routine proposal context so the LLM knows what it already proposed.
    // Cap at 20 to avoid system prompt bloat in long conversations.
    if (request.routineProposals && request.routineProposals.length > 0) {
      const proposals = request.routineProposals.slice(-20);
      const lines = proposals.map(
        (p) => `- "${p.name}" → ${p.status}`,
      );
      systemPrompt += `\n\n## Prior Routine Proposals (this conversation)\n${lines.join('\n')}\n` +
        `If a proposal was dismissed, do NOT re-propose it. If saved, the user already has it.`;
    }

    // Inject expert proposal context so the LLM knows what it already proposed.
    if (request.expertProposals && request.expertProposals.length > 0) {
      const proposals = request.expertProposals.slice(-20);
      const lines = proposals.map(
        (p) => `- "${p.name}" → ${p.status}`,
      );
      systemPrompt += `\n\n## Prior Expert Proposals (this conversation)\n${lines.join('\n')}\n` +
        `If a proposal was dismissed, do NOT re-propose it. If saved, the user already has it.`;
    }

    // ── Claude Code path ──────────────────────────────────────────
    if (isClaudeCode) {
      return this.startClaudeCodeRun(runId, webContents, request, resolvedModel, systemPrompt);
    }

    // Create orchestration tracker (lazy — no RunRecord until first orchestration action)
    const tracker = new OrchestrationTracker({
      runId,
      conversationId,
      expertId: expertId || null,
      parentRunId: request.parentRunId || null,
      backendPort: this.backendPort,
    });

    // Build tools
    const toolCtx = {
      expertId: expertId || null,
      conversationId,
      scope: expertId ? 'expert' : 'personal',
      scopeId: expertId || null,
      backendPort: this.backendPort,
      executionEngine: this.executionEngine ?? undefined,
      webContents,
      agentRuntime: this as AgentRuntime,
      parentRunId: runId,
      delegationDepth: request.delegationDepth ?? 0,
      orchestrationTracker: tracker,
    };
    const toolAccess = expertData?.tool_access ? JSON.parse(expertData.tool_access) : null;
    const rawTools = createToolsForExpert(toolCtx, toolAccess);

    // Apply enhanced loop: wrap tools, append tier guidance, create context transform
    const enhanced = createEnhancedAgentConfig(resolvedModel, rawTools, systemPrompt);
    const toolNames = enhanced.tools.map((t) => t.name);

    // Create agent with enhanced config
    const agent = createExpertAgent({
      systemPrompt: enhanced.systemPrompt,
      resolvedModel,
      tools: enhanced.tools,
      backendPort: this.backendPort,
      maxTurns: expertData?.max_turns ?? enhanced.tierConfig.maxTurns,
      transformContext: enhanced.transformContext as any,
      toolNames,
    });

    const log = createAgentLogger(runId);
    log.info('Starting run', { conversationId, expertId: expertId || 'cerebro', model: resolvedModel.displayName });

    // Create agent run record in backend
    this.backendPost('/agent-runs', {
      id: runId,
      expert_id: expertId || null,
      conversation_id: conversationId,
      parent_run_id: request.parentRunId || null,
      status: 'running',
    }).catch(console.error);

    // Construct activeRun before subscribing so the callback writes directly
    // to activeRun.accumulatedText (no separate closure variable).
    const channel = `agent:event:${runId}`;
    const turnCount = { value: 0 };
    const toolsUsed = new Set<string>();

    const activeRun: ActiveRun = {
      runId,
      conversationId,
      expertId: expertId || null,
      userContent: content,
      agent,
      unsubscribe: () => {}, // placeholder, set after subscribe
      governorUnsub: null,
      startedAt: Date.now(),
      accumulatedText: '',
      tracker,
    };

    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      // Track accumulated text — write directly to activeRun
      if (event.type === 'message_update') {
        const ame = (event as any).assistantMessageEvent;
        if (ame?.type === 'text_delta') {
          activeRun.accumulatedText += ame.delta;
        }
      }

      // Track tools used
      if (event.type === 'tool_execution_start') {
        toolsUsed.add(event.toolName);
        log.debug('Tool call', { tool: event.toolName });
      }

      let translated = translateEvent(event, runId, turnCount);
      if (translated) {
        // Inject orchestrationRunId into done events
        if (translated.type === 'done' && activeRun.tracker.isActive) {
          translated = { ...translated, orchestrationRunId: runId };
        }
        if (!webContents.isDestroyed()) {
          webContents.send(channel, translated);
        }
      }
    });

    activeRun.unsubscribe = unsubscribe;

    // Attach turn governor for turn limits & loop detection
    activeRun.governorUnsub = createTurnGovernor(agent, enhanced.tierConfig);

    this.activeRuns.set(runId, activeRun);

    // Emit run_start
    if (!webContents.isDestroyed()) {
      webContents.send(channel, { type: 'run_start', runId } as RendererAgentEvent);
    }

    // Start the agent loop (non-blocking)
    agent
      .prompt(content)
      .then(() => {
        log.info('Run completed', { text_length: activeRun.accumulatedText.length });
        this.finalizeRun(runId, 'completed', webContents, activeRun.accumulatedText, undefined, toolsUsed);

        // Resolve any delegation waiters
        const result: SubAgentResult = {
          runId,
          status: 'completed',
          messageContent: activeRun.accumulatedText,
        };
        this.resolveOrCacheResult(runId, result);
      })
      .catch((err: Error) => {
        const errorMsg = err.message || 'Agent run failed';
        log.error('Run failed', { error: errorMsg });
        if (!webContents.isDestroyed()) {
          webContents.send(channel, {
            type: 'error',
            runId,
            error: errorMsg,
          } as RendererAgentEvent);
        }
        this.finalizeRun(runId, 'error', webContents, activeRun.accumulatedText, errorMsg, toolsUsed);

        // Resolve any delegation waiters (with error status, not reject — let tool handle it)
        const result: SubAgentResult = {
          runId,
          status: 'error',
          messageContent: activeRun.accumulatedText,
          error: errorMsg,
        };
        this.resolveOrCacheResult(runId, result);
      });

    return runId;
  }

  cancelRun(runId: string): boolean {
    const run = this.activeRuns.get(runId);
    if (!run) return false;
    if (run.claudeCodeRunner) {
      run.claudeCodeRunner.abort();
    } else if (run.agent) {
      run.agent.abort();
    }
    this.finalizeRun(runId, 'cancelled', null, run.accumulatedText);

    // Reject any delegation waiters
    const completion = this.runCompletions.get(runId);
    if (completion) {
      this.runCompletions.delete(runId);
      completion.reject(new Error('Run was cancelled'));
    }

    // Cascade cancellation to child delegation and team member runs.
    // Collect IDs first to avoid mutating the Map during iteration.
    const delegatePrefix = `delegate:${runId}:`;
    const teamPrefix = `team:${runId}:`;
    const childRunIds: string[] = [];
    for (const [childRunId, childRun] of this.activeRuns) {
      if (childRun.conversationId.startsWith(delegatePrefix) ||
          childRun.conversationId.startsWith(teamPrefix)) {
        childRunIds.push(childRunId);
      }
    }
    for (const childRunId of childRunIds) {
      this.cancelRun(childRunId);
    }
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
   * Start a Claude Code CLI subprocess run.
   */
  private startClaudeCodeRun(
    runId: string,
    webContents: WebContents,
    request: AgentRunRequest,
    resolvedModel: ResolvedModel,
    systemPrompt: string,
  ): string {
    const { conversationId, content, expertId } = request;
    const channel = `agent:event:${runId}`;
    const log = createAgentLogger(runId);
    log.info('Starting Claude Code run', { conversationId, expertId: expertId || 'cerebro' });

    // Build conversation context from recent messages
    let fullPrompt = content;
    if (request.recentMessages && request.recentMessages.length > 0) {
      const MAX_MSG_CHARS = 500;
      const MAX_MESSAGES = 10;
      const recent = request.recentMessages.slice(-MAX_MESSAGES);
      const lines: string[] = [];
      for (const m of recent) {
        const tag = m.role === 'user' ? 'User' : 'Assistant';
        const text = m.content.length > MAX_MSG_CHARS
          ? m.content.slice(0, MAX_MSG_CHARS) + '...(truncated)'
          : m.content;
        lines.push(`${tag}: ${text}`);
      }
      fullPrompt = `Previous conversation:\n${lines.join('\n')}\n\nUser: ${content}`;
    }

    const tracker = new OrchestrationTracker({
      runId,
      conversationId,
      expertId: expertId || null,
      parentRunId: request.parentRunId || null,
      backendPort: this.backendPort,
    });

    const runner = new ClaudeCodeRunner();

    const activeRun: ActiveRun = {
      runId,
      conversationId,
      expertId: expertId || null,
      userContent: content,
      agent: null,
      unsubscribe: () => {},
      governorUnsub: null,
      startedAt: Date.now(),
      accumulatedText: '',
      tracker,
      claudeCodeRunner: runner,
    };

    this.activeRuns.set(runId, activeRun);

    // Emit run_start
    if (!webContents.isDestroyed()) {
      webContents.send(channel, { type: 'run_start', runId } as RendererAgentEvent);
    }

    // Forward runner events to renderer
    runner.on('event', (event: RendererAgentEvent) => {
      if (event.type === 'text_delta') {
        activeRun.accumulatedText += event.delta;
      }
      if (!webContents.isDestroyed()) {
        webContents.send(channel, event);
      }
    });

    runner.on('done', (messageContent: string) => {
      log.info('Claude Code run completed', { text_length: messageContent.length });
      this.finalizeRun(runId, 'completed', webContents, messageContent);

      const result: SubAgentResult = {
        runId,
        status: 'completed',
        messageContent,
      };
      this.resolveOrCacheResult(runId, result);
    });

    runner.on('error', (error: string) => {
      log.error('Claude Code run failed', { error });
      if (!webContents.isDestroyed()) {
        webContents.send(channel, {
          type: 'error',
          runId,
          error,
        } as RendererAgentEvent);
      }
      this.finalizeRun(runId, 'error', webContents, activeRun.accumulatedText, error);

      const result: SubAgentResult = {
        runId,
        status: 'error',
        messageContent: activeRun.accumulatedText,
        error,
      };
      this.resolveOrCacheResult(runId, result);
    });

    // Create MCP bridge for Cerebro memory tools
    const mcpBridge = createMcpBridge({
      runId,
      backendPort: this.backendPort,
      scope: expertId ? 'expert' : 'personal',
      scopeId: expertId || null,
      conversationId,
    });
    activeRun.mcpBridge = mcpBridge;

    // Create agent run record in backend
    this.backendPost('/agent-runs', {
      id: runId,
      expert_id: expertId || null,
      conversation_id: conversationId,
      parent_run_id: request.parentRunId || null,
      status: 'running',
    }).catch(console.error);

    // Start the subprocess
    runner.start({
      runId,
      prompt: fullPrompt,
      systemPrompt,
      mcpConfigPath: mcpBridge.configPath,
    });

    return runId;
  }

  /**
   * Resolve a delegation waiter, or cache the result if no waiter is registered yet.
   * Auto-evicts cached results after 5 minutes.
   */
  private resolveOrCacheResult(runId: string, result: SubAgentResult): void {
    const completion = this.runCompletions.get(runId);
    if (completion) {
      this.runCompletions.delete(runId);
      completion.resolve(result);
    } else {
      this.completedResults.set(runId, result);
      // 5-minute eviction — generous buffer beyond the 120s delegation timeout
      setTimeout(() => this.completedResults.delete(runId), 300_000);
    }
  }

  private finalizeRun(
    runId: string,
    status: string,
    _webContents: WebContents | null,
    messageContent: string,
    error?: string,
    toolsUsed?: Set<string>,
  ): void {
    const run = this.activeRuns.get(runId);
    if (!run) return;

    run.unsubscribe();
    run.governorUnsub?.();
    if (run.mcpBridge) {
      cleanupMcpBridge(run.mcpBridge);
    }
    this.activeRuns.delete(runId);

    // Finalize orchestration tracker if it was activated
    if (run.tracker.isActive) {
      const trackerStatus: 'completed' | 'error' | 'cancelled' =
        status === 'completed' ? 'completed'
        : status === 'cancelled' ? 'cancelled'
        : 'error';
      run.tracker.finalize(trackerStatus).catch((err) =>
        console.error('[OrchestrationTracker] Finalize failed:', err),
      );
    }

    // Update agent run record
    this.backendRequest('PATCH', `/agent-runs/${runId}`, {
      status,
      completed_at: new Date().toISOString(),
      error: error || null,
      tools_used: toolsUsed ? Array.from(toolsUsed) : null,
    }).catch(console.error);

    // Trigger memory extraction (fire-and-forget) if there's content
    if (messageContent && status === 'completed') {
      const scope = run.expertId ? 'expert' : 'personal';
      const scopeId = run.expertId || null;
      this.backendPost('/memory/extract', {
        conversation_id: run.conversationId,
        messages: [
          { role: 'user', content: run.userContent },
          { role: 'assistant', content: messageContent },
        ],
        scope,
        scope_id: scopeId,
      }).catch(() => {
        // Extraction is non-critical
      });
    }
  }

  private async fetchExpert(expertId: string): Promise<ExpertData | null> {
    try {
      return await this.backendGet<ExpertData>(`/experts/${expertId}`);
    } catch {
      return null;
    }
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
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
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
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
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
