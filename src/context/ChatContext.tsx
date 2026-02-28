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
import type { BackendResponse, StreamEvent } from '../types/ipc';
import {
  generateId,
  titleFromContent,
  fromApiConversation,
  type ApiConversationList,
} from './chat-helpers';

interface ChatState {
  conversations: Conversation[];
  activeConversationId: string | null;
  isStreaming: boolean;
  isThinking: boolean;
  isLoading: boolean;
  activeScreen: Screen;
}

interface ChatActions {
  createConversation: (firstMessage?: string) => string;
  setActiveConversation: (id: string | null) => void;
  addMessage: (conversationId: string, role: Message['role'], content: string) => void;
  updateMessage: (conversationId: string, messageId: string, partial: Partial<Message>) => void;
  deleteConversation: (id: string) => void;
  setActiveScreen: (screen: Screen) => void;
  sendMessage: (content: string) => void;
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
  msg: { id: string; role: string; content: string },
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
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationIdState] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [activeScreen, setActiveScreen] = useState<Screen>('chat');
  const abortRef = useRef<AbortController | null>(null);
  const conversationsRef = useRef<Conversation[]>([]);

  // Keep ref in sync so async callbacks always see latest state
  conversationsRef.current = conversations;

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

  const deleteConversation = useCallback((id: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    setActiveConversationIdState((current) => (current === id ? null : current));
    apiDeleteConversation(id).catch(console.error);
  }, []);

  // Stream a response from the local LLM
  const streamLlmResponse = useCallback(
    async (conversationId: string, modelName?: string) => {
      const assistantId = generateId();
      const thinkingMessage: Message = {
        id: assistantId,
        conversationId,
        role: 'assistant',
        content: '',
        model: modelName,
        createdAt: new Date(),
        isThinking: true,
      };

      setIsThinking(true);
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                messages: [...c.messages, thinkingMessage],
                updatedAt: new Date(),
              }
            : c,
        ),
      );

      // Gather conversation messages for the LLM from the ref (always current)
      const conv = conversationsRef.current.find((c) => c.id === conversationId);
      const chatMessages = (conv?.messages ?? [])
        .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
        .map((m) => ({ role: m.role, content: m.content }));

      try {
        const streamId = await window.cerebro.startStream({
          method: 'POST',
          path: '/models/chat',
          body: { messages: chatMessages, stream: true },
        });

        setIsThinking(false);
        setIsStreaming(true);
        updateMessage(conversationId, assistantId, {
          isThinking: false,
          isStreaming: true,
        });

        let accumulated = '';

        await new Promise<void>((resolve, reject) => {
          const unsub = window.cerebro.onStream(streamId, (event: StreamEvent) => {
            if (event.event === 'data') {
              try {
                const data = JSON.parse(event.data);
                if (data.token) {
                  accumulated += data.token;
                  updateMessage(conversationId, assistantId, { content: accumulated });
                }
                if (data.done) {
                  unsub();
                  resolve();
                }
              } catch {
                // ignore parse errors
              }
            } else if (event.event === 'end') {
              unsub();
              resolve();
            } else if (event.event === 'error') {
              unsub();
              reject(new Error(event.data));
            }
          });
        });

        // Finalize
        updateMessage(conversationId, assistantId, {
          content: accumulated,
          isStreaming: false,
        });
        apiCreateMessage(conversationId, {
          id: assistantId,
          role: 'assistant',
          content: accumulated,
        }).catch(console.error);
      } catch (e) {
        const errorMsg =
          e instanceof Error ? e.message : 'An error occurred while generating a response.';
        updateMessage(conversationId, assistantId, {
          content: `Error: ${errorMsg}`,
          isThinking: false,
          isStreaming: false,
        });
      } finally {
        setIsStreaming(false);
        setIsThinking(false);
      }
    },
    [updateMessage],
  );

  // Fallback when no model is loaded
  const showNoModelMessage = useCallback(
    (conversationId: string) => {
      const assistantId = generateId();
      const message: Message = {
        id: assistantId,
        conversationId,
        role: 'assistant',
        content: NO_MODEL_RESPONSE,
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
      apiCreateMessage(conversationId, {
        id: assistantId,
        role: 'assistant',
        content: NO_MODEL_RESPONSE,
      }).catch(console.error);
    },
    [],
  );

  const sendMessage = useCallback(
    (content: string) => {
      let convId = activeConversationId;
      if (!convId) {
        convId = createConversation(content);
      }
      addMessage(convId, 'user', content);

      // Check if a model is loaded by querying engine status
      window.cerebro
        .invoke<{ state: string; loaded_model_id: string | null }>({
          method: 'GET',
          path: '/models/status',
        })
        .then((res) => {
          if (res.ok && res.data.state === 'ready' && res.data.loaded_model_id) {
            streamLlmResponse(convId!, res.data.loaded_model_id);
          } else {
            showNoModelMessage(convId!);
          }
        })
        .catch(() => {
          showNoModelMessage(convId!);
        });
    },
    [activeConversationId, createConversation, addMessage, streamLlmResponse, showNoModelMessage],
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
        activeConversation,
        createConversation,
        setActiveConversation,
        addMessage,
        updateMessage,
        deleteConversation,
        setActiveScreen,
        sendMessage,
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
