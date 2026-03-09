import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import type { Conversation, Message, Screen, ToolCall, TeamRun, TeamRunMember } from '../types/chat';
import type { BackendResponse, StreamEvent, RendererAgentEvent } from '../types/ipc';
import type { SelectedModel, ProviderConnectionState } from '../types/providers';
import { useProviders } from './ProviderContext';
import { useModels } from './ModelContext';
import { useMemory } from './MemoryContext';
import { useRoutines } from './RoutineContext';
import type { DAGDefinition } from '../engine/dag/types';
import {
  generateId,
  titleFromContent,
  fromApiConversation,
  toApiProposal,
  toApiExpertProposal,
  toApiTeamProposal,
  type ApiConversationList,
} from './chat-helpers';

export interface ChatError {
  title: string;
  message: string;
  navigateTo?: Screen;
}

interface ChatState {
  conversations: Conversation[];
  activeConversationId: string | null;
  isStreaming: boolean;
  isThinking: boolean;
  isLoading: boolean;
  activeScreen: Screen;
  activeExpertId: string | null;
  chatError: ChatError | null;
}

interface ChatActions {
  createConversation: (firstMessage?: string) => string;
  setActiveConversation: (id: string | null) => void;
  addMessage: (conversationId: string, role: Message['role'], content: string, metadata?: Record<string, unknown>) => string;
  updateMessage: (conversationId: string, messageId: string, partial: Partial<Message>) => void;
  deleteConversation: (id: string) => void;
  setActiveScreen: (screen: Screen) => void;
  sendMessage: (content: string) => void;
  setActiveExpertId: (id: string | null) => void;
  dismissChatError: () => void;
}

type ChatContextValue = ChatState &
  ChatActions & {
    activeConversation: Conversation | undefined;
  };

const ChatContext = createContext<ChatContextValue | null>(null);

// ── API functions (fire-and-forget for writes) ───────────────────

async function apiLoadConversations(): Promise<Conversation[]> {
  const res: BackendResponse<ApiConversationList> = await window.cerebro.invoke({
    method: 'GET',
    path: '/conversations',
  });
  if (!res.ok) throw new Error(`Failed to load conversations: ${res.status}`);
  return res.data.conversations.map(fromApiConversation);
}

function apiCreateConversation(id: string, title: string): Promise<unknown> {
  return window.cerebro.invoke({
    method: 'POST',
    path: '/conversations',
    body: { id, title },
  });
}

function apiCreateMessage(
  convId: string,
  msg: { id: string; role: string; content: string; expert_id?: string; agent_run_id?: string; metadata?: Record<string, unknown> },
): Promise<unknown> {
  return window.cerebro.invoke({
    method: 'POST',
    path: `/conversations/${convId}/messages`,
    body: msg,
  });
}

function apiDeleteConversation(id: string): Promise<unknown> {
  return window.cerebro.invoke({
    method: 'DELETE',
    path: `/conversations/${id}`,
  });
}

const NO_MODEL_RESPONSE =
  'No model is currently loaded. Go to **Integrations** to download and load a local model, configure a cloud API key, or install Claude Code.';

export function ChatProvider({ children }: { children: ReactNode }) {
  const { selectedModel, connectionStatus, claudeCodeInfo } = useProviders();
  const { engineStatus } = useModels();
  const { getSystemPrompt, triggerExtraction } = useMemory();
  const { registerRunCallback } = useRoutines();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationIdState] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [activeScreen, setActiveScreen] = useState<Screen>('chat');
  const [activeExpertId, setActiveExpertId] = useState<string | null>(null);
  const [chatError, setChatError] = useState<ChatError | null>(null);
  const conversationsRef = useRef<Conversation[]>([]);

  // Keep ref in sync so async callbacks always see latest state
  conversationsRef.current = conversations;

  // Store refs so sendMessage always sees latest values
  const selectedModelRef = useRef<SelectedModel | null>(null);
  selectedModelRef.current = selectedModel;

  const engineStatusRef = useRef(engineStatus);
  engineStatusRef.current = engineStatus;

  const connectionStatusRef = useRef<Record<string, ProviderConnectionState>>({});
  connectionStatusRef.current = connectionStatus;

  const claudeCodeInfoRef = useRef(claudeCodeInfo);
  claudeCodeInfoRef.current = claudeCodeInfo;

  // Store memory functions in refs for async access
  const triggerExtractionRef = useRef(triggerExtraction);
  triggerExtractionRef.current = triggerExtraction;

  // ── Load conversations from backend on startup ─────────────────
  useEffect(() => {
    let cancelled = false;

    async function load() {
      // Wait for backend to become healthy (retry up to 15s)
      const maxRetries = 15;
      for (let i = 0; i < maxRetries; i++) {
        try {
          const status = await window.cerebro.getStatus();
          if (status === 'healthy') break;
        } catch {
          /* backend not ready */
        }
        if (cancelled) return;
        await new Promise((r) => setTimeout(r, 1000));
      }

      if (cancelled) return;

      try {
        const loaded = await apiLoadConversations();
        if (cancelled) return;
        // Merge: keep any in-flight conversations created during load
        setConversations((prev) => {
          const loadedIds = new Set(loaded.map((c) => c.id));
          const inFlight = prev.filter((c) => !loadedIds.has(c.id));
          return [...inFlight, ...loaded];
        });
      } catch (err) {
        console.error('Failed to load conversations:', err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const createConversation = useCallback((firstMessage?: string) => {
    const id = generateId();
    const now = new Date();
    const title = firstMessage ? titleFromContent(firstMessage) : 'New conversation';
    const conversation: Conversation = {
      id,
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    setConversations((prev) => [conversation, ...prev]);
    setActiveConversationIdState(id);
    apiCreateConversation(id, title).catch(console.error);
    return id;
  }, []);

  const setActiveConversation = useCallback((id: string | null) => {
    setActiveConversationIdState(id);
    if (id !== null) {
      setActiveScreen('chat');
    }
  }, []);

  const addMessage = useCallback(
    (conversationId: string, role: Message['role'], content: string, metadata?: Record<string, unknown>) => {
      const message: Message = {
        id: generateId(),
        conversationId,
        role,
        content,
        createdAt: new Date(),
      };
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                messages: [...c.messages, message],
                updatedAt: new Date(),
              }
            : c,
        ),
      );
      apiCreateMessage(conversationId, { id: message.id, role, content, metadata }).catch(console.error);
      return message.id;
    },
    [],
  );

  const updateMessage = useCallback(
    (conversationId: string, messageId: string, partial: Partial<Message>) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                messages: c.messages.map((m) => (m.id === messageId ? { ...m, ...partial } : m)),
              }
            : c,
        ),
      );
    },
    [],
  );

  const dismissChatError = useCallback(() => setChatError(null), []);

  const deleteConversation = useCallback((id: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    setActiveConversationIdState((current) => (current === id ? null : current));
    apiDeleteConversation(id).catch(console.error);
  }, []);

  const sendMessage = useCallback(
    (content: string) => {
      // ── Guard: require a usable model before doing anything ──
      const sel = selectedModelRef.current;
      const engineState = engineStatusRef.current.state;
      const localReady = engineState === 'ready';
      const localLoading = engineState === 'loading';
      let modelUsable = false;

      if (sel) {
        if (sel.source === 'claude-code') {
          // Claude Code: must be detected as available
          modelUsable = claudeCodeInfoRef.current.status === 'available';
        } else if (sel.source === 'local') {
          // Local model: engine must be ready or actively loading (auto-load on startup)
          modelUsable = localReady || localLoading;
        } else if (sel.source === 'cloud' && sel.provider) {
          // Cloud model: provider must have a key configured
          const cs = connectionStatusRef.current[sel.provider];
          modelUsable = !!cs && cs.status !== 'not_configured';
        }
      }

      // Fallback: even if selected_model is stale, a loaded/loading local model is usable
      if (!modelUsable && (localReady || localLoading)) {
        modelUsable = true;
      }

      if (!modelUsable) {
        setChatError({
          title: 'No model configured',
          message:
            'Set up a model provider, download a local model, or install Claude Code before chatting.',
          navigateTo: 'integrations',
        });
        return;
      }

      let convId = activeConversationId;
      if (!convId) {
        convId = createConversation(content);
      }
      addMessage(convId, 'user', content);

      const expertId = activeExpertId;

      // Create placeholder assistant message
      const assistantId = generateId();
      const thinkingMessage: Message = {
        id: assistantId,
        conversationId: convId,
        role: 'assistant',
        content: '',
        expertId: expertId ?? undefined,
        createdAt: new Date(),
        isThinking: true,
      };

      setIsThinking(true);
      setConversations((prev) =>
        prev.map((c) =>
          c.id === convId
            ? {
                ...c,
                messages: [...c.messages, thinkingMessage],
                updatedAt: new Date(),
              }
            : c,
        ),
      );

      // Route through agent system
      const runAgent = async () => {
        try {
          // Collect conversation context so the LLM has multi-turn awareness.
          const conv = conversationsRef.current.find((c) => c.id === convId);
          const allMessages = conv?.messages ?? [];

          // Recent messages — gives the LLM conversational continuity across turns.
          // Note: React batches state updates, so conversationsRef still has the
          // pre-addMessage state here. No need to exclude the just-added message.
          const MAX_RECENT = 10;
          const recentMessages = allMessages
            .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content && !m.isThinking)
            .slice(-MAX_RECENT)
            .map((m) => {
              let enrichedContent = m.content;
              // Enrich assistant messages with successful tool call outputs
              if (m.role === 'assistant' && m.toolCalls?.length) {
                for (const tc of m.toolCalls) {
                  if (tc.status === 'success' && tc.output) {
                    const truncatedOutput = tc.output.length > 200
                      ? tc.output.slice(0, 200) + '...'
                      : tc.output;
                    enrichedContent += `\n[Used ${tc.name}: ${truncatedOutput}]`;
                  }
                }
              }
              return { role: m.role as 'user' | 'assistant', content: enrichedContent };
            });

          // Routine proposal snapshots — so the LLM knows what it proposed and what happened.
          const routineProposals = allMessages
            .filter((m) => m.routineProposal)
            .map((m) => ({
              name: m.routineProposal!.name,
              status: m.routineProposal!.status,
            }));

          // Expert proposal snapshots — so the LLM knows what it proposed and what happened.
          const expertProposals = allMessages
            .filter((m) => m.expertProposal)
            .map((m) => ({
              name: m.expertProposal!.name,
              status: m.expertProposal!.status,
            }));

          const runId = await window.cerebro.agent.run({
            conversationId: convId!,
            content,
            expertId,
            recentMessages: recentMessages.length > 0 ? recentMessages : undefined,
            routineProposals: routineProposals.length > 0 ? routineProposals : undefined,
            expertProposals: expertProposals.length > 0 ? expertProposals : undefined,
          });

          // Keep isThinking true and message.isThinking true until first content arrives
          setIsStreaming(true);

          let accumulated = '';
          let thinkingCleared = false;
          const toolCalls: ToolCall[] = [];
          let accEngineRunId: string | undefined;
          let accRoutineProposal: import('../types/chat').RoutineProposal | undefined;
          let accExpertProposal: import('../types/chat').ExpertProposal | undefined;
          let accTeamProposal: import('../types/chat').TeamProposal | undefined;
          let accOrchestrationRunId: string | undefined;

          const clearThinking = () => {
            if (!thinkingCleared) {
              thinkingCleared = true;
              setIsThinking(false);
              updateMessage(convId!, assistantId, { isThinking: false, isStreaming: true });
            }
          };

          const unsub = window.cerebro.agent.onEvent(runId, (event: RendererAgentEvent) => {
            switch (event.type) {
              case 'text_delta':
                clearThinking();
                accumulated += event.delta;
                updateMessage(convId!, assistantId, { content: accumulated });
                break;

              case 'tool_start':
                clearThinking();
                toolCalls.push({
                  id: event.toolCallId,
                  name: event.toolName,
                  description: event.toolName,
                  arguments: event.args as Record<string, unknown>,
                  status: 'running',
                  startedAt: new Date(),
                });
                updateMessage(convId!, assistantId, { toolCalls: [...toolCalls] });
                break;

              case 'tool_end': {
                const tc = toolCalls.find((t) => t.id === event.toolCallId);
                if (tc) {
                  tc.status = event.isError ? 'error' : 'success';
                  tc.output = event.result;
                  tc.completedAt = new Date();
                  updateMessage(convId!, assistantId, { toolCalls: [...toolCalls] });
                }
                // Detect run_routine tool result and attach engineRunId
                if (event.toolName === 'run_routine' && !event.isError) {
                  const marker = event.result.match(/\[ENGINE_RUN_ID:([^\]]+)\]/);
                  if (marker) {
                    accEngineRunId = marker[1];
                    updateMessage(convId!, assistantId, { engineRunId: marker[1] });
                  }
                }
                // Detect propose_routine tool result and attach proposal to message
                if (event.toolName === 'propose_routine' && !event.isError) {
                  try {
                    const parsed = JSON.parse(event.result);
                    if (parsed.type === 'routine_proposal') {
                      accRoutineProposal = {
                        name: parsed.name,
                        description: parsed.description ?? '',
                        steps: parsed.steps,
                        triggerType: parsed.triggerType,
                        cronExpression: parsed.cronExpression,
                        defaultRunnerId: parsed.defaultRunnerId,
                        requiredConnections: parsed.requiredConnections ?? [],
                        approvalGates: parsed.approvalGates ?? [],
                        status: 'proposed',
                      };
                      updateMessage(convId!, assistantId, {
                        routineProposal: accRoutineProposal,
                      });
                    }
                  } catch { /* not valid JSON, treat as normal result */ }
                }
                // Detect propose_expert tool result and attach proposal to message
                if (event.toolName === 'propose_expert' && !event.isError) {
                  try {
                    const parsed = JSON.parse(event.result);
                    if (parsed.type === 'expert_proposal') {
                      accExpertProposal = {
                        name: parsed.name,
                        description: parsed.description ?? '',
                        domain: parsed.domain ?? '',
                        systemPrompt: parsed.systemPrompt ?? '',
                        toolAccess: parsed.toolAccess ?? [],
                        suggestedContextFile: parsed.suggestedContextFile,
                        status: 'proposed',
                      };
                      updateMessage(convId!, assistantId, {
                        expertProposal: accExpertProposal,
                      });
                    }
                  } catch { /* not valid JSON, treat as normal result */ }
                }
                // Detect propose_team tool result and attach proposal to message
                if (event.toolName === 'propose_team' && !event.isError) {
                  try {
                    const parsed = JSON.parse(event.result);
                    if (parsed.type === 'team_proposal') {
                      accTeamProposal = {
                        name: parsed.name,
                        description: parsed.description ?? '',
                        strategy: parsed.strategy ?? 'auto',
                        members: (parsed.members ?? []).map((m: Record<string, unknown>, i: number) => ({
                          expertId: (m.expert_id as string | null) ?? null,
                          name: (m.name as string | null) ?? null,
                          role: m.role as string,
                          description: (m.description as string | null) ?? null,
                          order: (m.order as number) ?? i,
                        })),
                        coordinatorPrompt: parsed.coordinatorPrompt ?? null,
                        status: 'proposed',
                      };
                      updateMessage(convId!, assistantId, {
                        teamProposal: accTeamProposal,
                      });
                    } else {
                      console.warn('propose_team result missing type=team_proposal:', event.result.slice(0, 200));
                    }
                  } catch (e) {
                    console.warn('propose_team result is not valid JSON:', event.result.slice(0, 200), e);
                  }
                }
                break;
              }

              case 'delegation_start': {
                // Enrich the active delegate_to_expert tool call with the expert name
                const delegationTc = toolCalls.find(
                  (t) => t.name === 'delegate_to_expert' && t.status === 'running',
                );
                if (delegationTc) {
                  delegationTc.delegationExpertName = event.expertName;
                  updateMessage(convId!, assistantId, { toolCalls: [...toolCalls] });
                }
                break;
              }

              case 'delegation_end':
                // No-op: tool_end already handles status finalization
                break;

              case 'team_started': {
                const teamRun: TeamRun = {
                  teamId: event.teamId,
                  teamName: event.teamName,
                  strategy: event.strategy,
                  members: [],
                  status: 'running',
                };
                updateMessage(convId!, assistantId, { teamRun });
                break;
              }

              case 'member_queued': {
                setConversations((prev) =>
                  prev.map((c) => {
                    if (c.id !== convId) return c;
                    return {
                      ...c,
                      messages: c.messages.map((m) => {
                        if (m.id !== assistantId || !m.teamRun) return m;
                        const newMember: TeamRunMember = {
                          memberId: event.memberId,
                          memberName: event.memberName,
                          role: event.role,
                          status: 'queued',
                        };
                        return {
                          ...m,
                          teamRun: { ...m.teamRun, members: [...m.teamRun.members, newMember] },
                        };
                      }),
                    };
                  }),
                );
                break;
              }

              case 'member_started': {
                setConversations((prev) =>
                  prev.map((c) => {
                    if (c.id !== convId) return c;
                    return {
                      ...c,
                      messages: c.messages.map((m) => {
                        if (m.id !== assistantId || !m.teamRun) return m;
                        return {
                          ...m,
                          teamRun: {
                            ...m.teamRun,
                            members: m.teamRun.members.map((mem) =>
                              mem.memberId === event.memberId ? { ...mem, status: 'running' as const } : mem,
                            ),
                          },
                        };
                      }),
                    };
                  }),
                );
                break;
              }

              case 'member_completed': {
                setConversations((prev) =>
                  prev.map((c) => {
                    if (c.id !== convId) return c;
                    return {
                      ...c,
                      messages: c.messages.map((m) => {
                        if (m.id !== assistantId || !m.teamRun) return m;
                        return {
                          ...m,
                          teamRun: {
                            ...m.teamRun,
                            members: m.teamRun.members.map((mem) =>
                              mem.memberId === event.memberId
                                ? { ...mem, status: event.status, response: event.response }
                                : mem,
                            ),
                          },
                        };
                      }),
                    };
                  }),
                );
                break;
              }

              case 'team_synthesis':
                // Visual indicator handled by running status
                break;

              case 'team_completed': {
                setConversations((prev) =>
                  prev.map((c) => {
                    if (c.id !== convId) return c;
                    return {
                      ...c,
                      messages: c.messages.map((m) => {
                        if (m.id !== assistantId || !m.teamRun) return m;
                        return {
                          ...m,
                          teamRun: {
                            ...m.teamRun,
                            status: event.status,
                            successCount: event.successCount,
                            totalCount: event.totalCount,
                          },
                        };
                      }),
                    };
                  }),
                );
                break;
              }

              case 'done': {
                unsub();
                clearThinking();
                setIsStreaming(false);
                // Capture orchestrationRunId
                if (event.orchestrationRunId) {
                  accOrchestrationRunId = event.orchestrationRunId;
                }
                updateMessage(convId!, assistantId, {
                  content: event.messageContent || accumulated,
                  isThinking: false,
                  isStreaming: false,
                  agentRunId: runId,
                  orchestrationRunId: accOrchestrationRunId,
                });
                // Build metadata for persistence
                const doneMetadata: Record<string, unknown> = {};
                if (accEngineRunId) doneMetadata.engine_run_id = accEngineRunId;
                if (accOrchestrationRunId) doneMetadata.orchestration_run_id = accOrchestrationRunId;
                if (accRoutineProposal) doneMetadata.routine_proposal = toApiProposal(accRoutineProposal);
                if (accExpertProposal) doneMetadata.expert_proposal = toApiExpertProposal(accExpertProposal);
                if (accTeamProposal) doneMetadata.team_proposal = toApiTeamProposal(accTeamProposal);
                // Persist team run if present — read latest state from conversations ref
                const doneConv = conversationsRef.current.find((c) => c.id === convId);
                const doneMsg = doneConv?.messages.find((m) => m.id === assistantId);
                if (doneMsg?.teamRun) {
                  doneMetadata.team_run = {
                    team_id: doneMsg.teamRun.teamId,
                    team_name: doneMsg.teamRun.teamName,
                    strategy: doneMsg.teamRun.strategy,
                    status: doneMsg.teamRun.status,
                    success_count: doneMsg.teamRun.successCount,
                    total_count: doneMsg.teamRun.totalCount,
                    members: doneMsg.teamRun.members.map((mem) => ({
                      member_id: mem.memberId,
                      member_name: mem.memberName,
                      role: mem.role,
                      status: mem.status,
                      response: mem.response,
                    })),
                  };
                }
                // Persist final message
                apiCreateMessage(convId!, {
                  id: assistantId,
                  role: 'assistant',
                  content: event.messageContent || accumulated,
                  expert_id: expertId ?? undefined,
                  agent_run_id: runId,
                  metadata: Object.keys(doneMetadata).length > 0 ? doneMetadata : undefined,
                }).catch(console.error);
                break;
              }

              case 'error': {
                unsub();
                clearThinking();
                setIsStreaming(false);

                const isNoModel =
                  /no model/i.test(event.error) || /not.*available/i.test(event.error);

                if (isNoModel) {
                  setConversations((prev) =>
                    prev.map((c) =>
                      c.id === convId
                        ? { ...c, messages: c.messages.filter((m) => m.id !== assistantId) }
                        : c,
                    ),
                  );
                  setChatError({
                    title: 'No model configured',
                    message:
                      'Set up a model provider, download a local model, or install Claude Code before chatting.',
                    navigateTo: 'integrations',
                  });
                } else {
                  updateMessage(convId!, assistantId, {
                    content: `Error: ${event.error}`,
                    isThinking: false,
                    isStreaming: false,
                  });
                }
                break;
              }
            }
          });
        } catch (e) {
          const errorMsg =
            e instanceof Error ? e.message : 'An error occurred while starting the agent.';
          setIsStreaming(false);
          setIsThinking(false);

          // Detect "no model" errors and show modal instead of inline error
          const isNoModel =
            /no model/i.test(errorMsg) || /not.*available/i.test(errorMsg);

          if (isNoModel) {
            // Remove the thinking placeholder — no point showing an error bubble
            setConversations((prev) =>
              prev.map((c) =>
                c.id === convId
                  ? { ...c, messages: c.messages.filter((m) => m.id !== assistantId) }
                  : c,
              ),
            );
            setChatError({
              title: 'No model configured',
              message:
                'Set up a model provider, download a local model, or install Claude Code before chatting.',
              navigateTo: 'integrations',
            });
          } else {
            updateMessage(convId!, assistantId, {
              content: `Error: ${errorMsg}`,
              isThinking: false,
              isStreaming: false,
            });
          }
        }
      };

      runAgent();
    },
    [activeConversationId, activeExpertId, createConversation, addMessage, updateMessage],
  );

  // ── Run routine in chat (triggered via UI "Run Now" button) ────
  const runRoutineInChat = useCallback(
    (info: { id: string; name: string; dagJson: string }) => {
      // Create or reuse conversation
      let convId = activeConversationId;
      if (!convId) {
        convId = createConversation(`Run routine: ${info.name}`);
      }
      setActiveScreen('chat');

      // Add assistant message placeholder
      const msgId = generateId();
      const msg: Message = {
        id: msgId,
        conversationId: convId,
        role: 'assistant',
        content: `Running routine **${info.name}**...`,
        createdAt: new Date(),
      };
      setConversations((prev) =>
        prev.map((c) =>
          c.id === convId
            ? { ...c, messages: [...c.messages, msg], updatedAt: new Date() }
            : c,
        ),
      );

      // Parse DAG and start engine run
      let dag: DAGDefinition;
      try {
        dag = JSON.parse(info.dagJson);
      } catch {
        updateMessage(convId, msgId, { content: `Failed to parse DAG for routine **${info.name}**.` });
        return;
      }

      window.cerebro.engine
        .run({ dag, routineId: info.id, triggerSource: 'manual' })
        .then((runId) => {
          const content = `Running routine **${info.name}**...`;
          updateMessage(convId!, msgId, { engineRunId: runId });
          // Persist the run log message so it survives reload
          apiCreateMessage(convId!, {
            id: msgId,
            role: 'assistant',
            content,
            metadata: { engine_run_id: runId },
          }).catch(console.error);
          // Bump backend metadata (fire-and-forget)
          window.cerebro
            .invoke({ method: 'POST', path: `/routines/${info.id}/run` })
            .catch(console.error);
        })
        .catch((err) => {
          const errorContent = `Failed to run routine **${info.name}**: ${err instanceof Error ? err.message : String(err)}`;
          updateMessage(convId!, msgId, { content: errorContent });
          apiCreateMessage(convId!, {
            id: msgId,
            role: 'assistant',
            content: errorContent,
          }).catch(console.error);
        });
    },
    [activeConversationId, createConversation, updateMessage],
  );

  // Register with RoutineContext so "Run Now" buttons trigger chat flow
  useEffect(() => {
    registerRunCallback(runRoutineInChat);
  }, [registerRunCallback, runRoutineInChat]);

  const activeConversation = conversations.find((c) => c.id === activeConversationId);

  return (
    <ChatContext.Provider
      value={{
        conversations,
        activeConversationId,
        isStreaming,
        isThinking,
        isLoading,
        activeScreen,
        activeExpertId,
        chatError,
        activeConversation,
        createConversation,
        setActiveConversation,
        addMessage,
        updateMessage,
        deleteConversation,
        setActiveScreen,
        sendMessage,
        setActiveExpertId,
        dismissChatError,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be used within ChatProvider');
  return ctx;
}
