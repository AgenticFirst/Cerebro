import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import type { Conversation, Message, Screen, ToolCall } from '../types/chat';
import type { BackendResponse, RendererAgentEvent } from '../types/ipc';
import { useProviders } from './ProviderContext';
import { useRoutines } from './RoutineContext';
import i18n from '../i18n';
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

interface CreateConversationOptions {
  expertId?: string | null;
}

interface ChatActions {
  createConversation: (firstMessage?: string, opts?: CreateConversationOptions) => string;
  setActiveConversation: (id: string | null) => void;
  addMessage: (conversationId: string, role: Message['role'], content: string, metadata?: Record<string, unknown>) => string;
  updateMessage: (conversationId: string, messageId: string, partial: Partial<Message>) => void;
  deleteConversation: (id: string) => void;
  setActiveScreen: (screen: Screen) => void;
  sendMessage: (content: string) => void;
  setActiveExpertId: (id: string | null) => void;
  dismissChatError: () => void;
  getConversationsForExpert: (expertId: string) => Conversation[];
  generalConversations: Conversation[];
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

function apiCreateConversation(
  id: string,
  title: string,
  expertId?: string | null,
): Promise<unknown> {
  return window.cerebro.invoke({
    method: 'POST',
    path: '/conversations',
    body: { id, title, expert_id: expertId ?? null },
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

export function ChatProvider({ children }: { children: ReactNode }) {
  const { claudeCodeInfo } = useProviders();
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

  const claudeCodeInfoRef = useRef(claudeCodeInfo);
  claudeCodeInfoRef.current = claudeCodeInfo;

  // Per-conversation write chain. Every backend write for a conversation is
  // appended to this promise so writes commit in the order the UI fires them.
  // Without this, the optimistic-first pattern lets the very first user message
  // race ahead of the conversation row insert and the agent_run insert (which
  // both reference conversation_id), producing FK violations and 404s.
  const writeChainRef = useRef<Map<string, Promise<unknown>>>(new Map());

  const chainWrite = useCallback(
    <T,>(convId: string, fn: () => Promise<T>): Promise<T> => {
      const prev = writeChainRef.current.get(convId) ?? Promise.resolve();
      const next = prev.catch(() => undefined).then(() => fn());
      writeChainRef.current.set(
        convId,
        next.catch(() => undefined),
      );
      return next;
    },
    [],
  );

  const waitForConversation = useCallback(async (convId: string) => {
    const pending = writeChainRef.current.get(convId);
    if (pending) {
      try { await pending; } catch { /* swallow — caller decides what to do */ }
    }
  }, []);

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

  const createConversation = useCallback(
    (firstMessage?: string, opts?: CreateConversationOptions) => {
      const id = generateId();
      const now = new Date();
      const title = firstMessage ? titleFromContent(firstMessage) : 'New conversation';
      const expertId = opts?.expertId ?? null;
      const conversation: Conversation = {
        id,
        title,
        expertId,
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      setConversations((prev) => [conversation, ...prev]);
      setActiveConversationIdState(id);
      chainWrite(id, () => apiCreateConversation(id, title, expertId)).catch(console.error);
      return id;
    },
    [chainWrite],
  );

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
      chainWrite(conversationId, () =>
        apiCreateMessage(conversationId, { id: message.id, role, content, metadata }),
      ).catch(console.error);
      return message.id;
    },
    [chainWrite],
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
    writeChainRef.current.delete(id);
    apiDeleteConversation(id).catch(console.error);
  }, []);

  const sendMessage = useCallback(
    (content: string) => {
      // ── Guard: require Claude Code to be detected ──
      if (claudeCodeInfoRef.current.status !== 'available') {
        setChatError({
          title: 'Claude Code not detected',
          message:
            'Cerebro uses the Claude Code CLI as its engine. Install it and re-detect from Integrations.',
          navigateTo: 'integrations',
        });
        return;
      }

      let convId = activeConversationId;
      if (!convId) {
        // Auto-scope new conversations to the selected expert so threads
        // started from the Experts > Messages tab are discoverable there.
        convId = createConversation(content, { expertId: activeExpertId });
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
          // Wait for the conversation row + user message insert to commit before
          // spawning the agent run. The runtime persists an `agent_runs` row with
          // a FK to `conversation_id`, so the conversation must exist first or
          // the insert fails with a FK violation.
          await waitForConversation(convId!);

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
            language: i18n.language !== 'en' ? i18n.language : undefined,
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
                // Resolve tool name: prefer event (may be empty for nested tool_result), fallback to tc
                const resolvedToolName = event.toolName || tc?.name || '';
                // Detect run_routine tool result and attach engineRunId
                if (resolvedToolName === 'run_routine' && !event.isError) {
                  const marker = event.result.match(/\[ENGINE_RUN_ID:([^\]]+)\]/);
                  if (marker) {
                    accEngineRunId = marker[1];
                    updateMessage(convId!, assistantId, { engineRunId: marker[1] });
                  }
                }
                // Detect propose_routine tool result and attach proposal to message
                if (resolvedToolName === 'propose_routine' && !event.isError) {
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
                if (resolvedToolName === 'propose_expert' && !event.isError) {
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
                break;
              }

              case 'done': {
                unsub();
                clearThinking();
                setIsStreaming(false);
                // Safety net: force-complete any tool calls still running
                for (const tc of toolCalls) {
                  if (tc.status === 'running') {
                    tc.status = 'success';
                    tc.completedAt = new Date();
                  }
                }
                updateMessage(convId!, assistantId, {
                  content: event.messageContent || accumulated,
                  isThinking: false,
                  isStreaming: false,
                  agentRunId: runId,
                  toolCalls: [...toolCalls],
                });
                // Build metadata for persistence
                const doneMetadata: Record<string, unknown> = {};
                if (accEngineRunId) doneMetadata.engine_run_id = accEngineRunId;
                if (accRoutineProposal) doneMetadata.routine_proposal = toApiProposal(accRoutineProposal);
                if (accExpertProposal) doneMetadata.expert_proposal = toApiExpertProposal(accExpertProposal);
                if (accTeamProposal) doneMetadata.team_proposal = toApiTeamProposal(accTeamProposal);
                // Persist final message — chained so it runs after the
                // conversation/user-message inserts have committed.
                chainWrite(convId!, () =>
                  apiCreateMessage(convId!, {
                    id: assistantId,
                    role: 'assistant',
                    content: event.messageContent || accumulated,
                    expert_id: expertId ?? undefined,
                    agent_run_id: runId,
                    metadata: Object.keys(doneMetadata).length > 0 ? doneMetadata : undefined,
                  }),
                ).catch(console.error);
                break;
              }

              case 'error': {
                unsub();
                clearThinking();
                setIsStreaming(false);
                // Safety net: mark any still-running tool calls as errored
                for (const tc of toolCalls) {
                  if (tc.status === 'running') {
                    tc.status = 'error';
                    tc.output = tc.output || 'Interrupted';
                    tc.completedAt = new Date();
                  }
                }
                updateMessage(convId!, assistantId, {
                  content: `Error: ${event.error}`,
                  isThinking: false,
                  isStreaming: false,
                  toolCalls: [...toolCalls],
                });
                break;
              }
            }
          });
        } catch (e) {
          const errorMsg =
            e instanceof Error ? e.message : 'An error occurred while starting the agent.';
          setIsStreaming(false);
          setIsThinking(false);
          updateMessage(convId!, assistantId, {
            content: `Error: ${errorMsg}`,
            isThinking: false,
            isStreaming: false,
          });
        }
      };

      runAgent();
    },
    [activeConversationId, activeExpertId, createConversation, addMessage, updateMessage, chainWrite, waitForConversation],
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

      // Wait for the conversation row insert to commit before persisting the
      // routine log message and triggering the engine run.
      waitForConversation(convId!).then(() => {
        window.cerebro.engine
          .run({ dag, routineId: info.id, triggerSource: 'manual' })
          .then((runId) => {
            const content = `Running routine **${info.name}**...`;
            updateMessage(convId!, msgId, { engineRunId: runId });
            // Persist the run log message so it survives reload
            chainWrite(convId!, () =>
              apiCreateMessage(convId!, {
                id: msgId,
                role: 'assistant',
                content,
                metadata: { engine_run_id: runId },
              }),
            ).catch(console.error);
            // Bump backend metadata (fire-and-forget)
            window.cerebro
              .invoke({ method: 'POST', path: `/routines/${info.id}/run` })
              .catch(console.error);
          })
          .catch((err) => {
            const errorContent = `Failed to run routine **${info.name}**: ${err instanceof Error ? err.message : String(err)}`;
            updateMessage(convId!, msgId, { content: errorContent });
            chainWrite(convId!, () =>
              apiCreateMessage(convId!, {
                id: msgId,
                role: 'assistant',
                content: errorContent,
              }),
            ).catch(console.error);
          });
      });
    },
    [activeConversationId, createConversation, updateMessage, chainWrite, waitForConversation],
  );

  // Register with RoutineContext so "Run Now" buttons trigger chat flow
  useEffect(() => {
    registerRunCallback(runRoutineInChat);
  }, [registerRunCallback, runRoutineInChat]);

  const activeConversation = conversations.find((c) => c.id === activeConversationId);

  const generalConversations = useMemo(
    () => conversations.filter((c) => !c.expertId),
    [conversations],
  );

  const conversationsByExpert = useMemo(() => {
    const map = new Map<string, Conversation[]>();
    for (const c of conversations) {
      if (!c.expertId) continue;
      const list = map.get(c.expertId) ?? [];
      list.push(c);
      map.set(c.expertId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    }
    return map;
  }, [conversations]);

  const getConversationsForExpert = useCallback(
    (expertId: string) => conversationsByExpert.get(expertId) ?? [],
    [conversationsByExpert],
  );

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
        getConversationsForExpert,
        generalConversations,
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
