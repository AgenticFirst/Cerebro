import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import type { Conversation, Message, Screen, ToolCall } from '../types/chat';
import type { BackendResponse, StreamEvent, RendererAgentEvent } from '../types/ipc';
import type { SelectedModel, ProviderConnectionState } from '../types/providers';
import { useProviders } from './ProviderContext';
import { useModels } from './ModelContext';
import { useMemory } from './MemoryContext';
import {
  generateId,
  titleFromContent,
  fromApiConversation,
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
  addMessage: (conversationId: string, role: Message['role'], content: string) => void;
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
  msg: { id: string; role: string; content: string; expert_id?: string; agent_run_id?: string },
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
  'No model is currently loaded. Go to **Integrations** to download and load a local model, or configure a cloud API key.';

export function ChatProvider({ children }: { children: ReactNode }) {
  const { selectedModel, connectionStatus } = useProviders();
  const { engineStatus } = useModels();
  const { getSystemPrompt, triggerExtraction } = useMemory();
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
    (conversationId: string, role: Message['role'], content: string) => {
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
      apiCreateMessage(conversationId, { id: message.id, role, content }).catch(console.error);
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
      const localReady = engineStatusRef.current.state === 'ready';
      let modelUsable = false;

      if (sel) {
        if (sel.source === 'local') {
          // Local model: engine must be ready
          modelUsable = localReady;
        } else if (sel.source === 'cloud' && sel.provider) {
          // Cloud model: provider must have a key configured
          const cs = connectionStatusRef.current[sel.provider];
          modelUsable = !!cs && cs.status !== 'not_configured';
        }
      }

      // Fallback: even if selected_model is stale, a loaded local model is usable
      if (!modelUsable && localReady) {
        modelUsable = true;
      }

      if (!modelUsable) {
        setChatError({
          title: 'No model configured',
          message:
            'Set up a model provider (Anthropic, OpenAI, or Google) or download a local model before chatting.',
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
          const runId = await window.cerebro.agent.run({
            conversationId: convId!,
            content,
            expertId,
          });

          setIsThinking(false);
          setIsStreaming(true);
          updateMessage(convId!, assistantId, { isThinking: false, isStreaming: true });

          let accumulated = '';
          const toolCalls: ToolCall[] = [];

          const unsub = window.cerebro.agent.onEvent(runId, (event: RendererAgentEvent) => {
            switch (event.type) {
              case 'text_delta':
                accumulated += event.delta;
                updateMessage(convId!, assistantId, { content: accumulated });
                break;

              case 'tool_start':
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
                break;
              }

              case 'done':
                unsub();
                setIsStreaming(false);
                updateMessage(convId!, assistantId, {
                  content: event.messageContent || accumulated,
                  isStreaming: false,
                  agentRunId: runId,
                });
                // Persist final message
                apiCreateMessage(convId!, {
                  id: assistantId,
                  role: 'assistant',
                  content: event.messageContent || accumulated,
                  expert_id: expertId ?? undefined,
                  agent_run_id: runId,
                }).catch(console.error);
                break;

              case 'error': {
                unsub();
                setIsStreaming(false);
                setIsThinking(false);

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
                      'Set up a model provider (Anthropic, OpenAI, or Google) or download a local model before chatting.',
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
                'Set up a model provider (Anthropic, OpenAI, or Google) or download a local model before chatting.',
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
