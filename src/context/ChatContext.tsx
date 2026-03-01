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
import type { SelectedModel } from '../types/providers';
import { useProviders } from './ProviderContext';
import { useMemory } from './MemoryContext';
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
  const { selectedModel } = useProviders();
  const { getSystemPrompt, triggerExtraction } = useMemory();
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

  // Store selectedModel in a ref so sendMessage always has the latest value
  const selectedModelRef = useRef<SelectedModel | null>(null);
  selectedModelRef.current = selectedModel;

  // Store memory functions in refs for async access
  const getSystemPromptRef = useRef(getSystemPrompt);
  getSystemPromptRef.current = getSystemPrompt;
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

  const deleteConversation = useCallback((id: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    setActiveConversationIdState((current) => (current === id ? null : current));
    apiDeleteConversation(id).catch(console.error);
  }, []);

  // ── Shared streaming helper ────────────────────────────────────
  const streamResponse = useCallback(
    async (
      conversationId: string,
      modelDisplayName: string,
      streamPath: string,
      streamBody: Record<string, unknown>,
    ) => {
      const assistantId = generateId();
      const thinkingMessage: Message = {
        id: assistantId,
        conversationId,
        role: 'assistant',
        content: '',
        model: modelDisplayName,
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

      try {
        const streamId = await window.cerebro.startStream({
          method: 'POST',
          path: streamPath,
          body: streamBody,
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
                  // Check if this is an error response (finish_reason "error" with no content)
                  if (data.finish_reason === 'error') {
                    const errorDetail = data.usage?.error || 'Request failed';
                    unsub();
                    reject(new Error(errorDetail));
                    return;
                  }
                  unsub();
                  resolve();
                }
              } catch {
                // ignore parse errors
              }
            } else if (event.event === 'end') {
              unsub();
              // If stream ended with no content at all, treat as error
              if (!accumulated) {
                reject(new Error('No response received from the model. Check your API key and model configuration.'));
              } else {
                resolve();
              }
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

        // Trigger memory extraction (fire-and-forget)
        if (accumulated) {
          const recentPair = [
            ...(streamBody.messages as Array<{ role: string; content: string }> || []).slice(-1),
            { role: 'assistant', content: accumulated },
          ];
          triggerExtractionRef.current(conversationId, recentPair);
        }
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

  // Fallback when no model is selected
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

      const model = selectedModelRef.current;

      // Build message history including the just-sent user message.
      // We can't rely on conversationsRef (state hasn't flushed yet),
      // so we read the ref and append the current message manually.
      const conv = conversationsRef.current.find((c) => c.id === convId);
      const priorMessages = (conv?.messages ?? [])
        .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
        .map((m) => ({ role: m.role, content: m.content }));
      const chatMessages = [...priorMessages, { role: 'user', content }];

      // Fetch memory-assembled system prompt, then dispatch to model
      const dispatch = async (messagesWithMemory: Array<{ role: string; content: string }>) => {
        if (!model) {
          // No model selected — check if a local model is loaded (backward compat)
          try {
            const res = await window.cerebro.invoke<{
              state: string;
              loaded_model_id: string | null;
            }>({ method: 'GET', path: '/models/status' });
            if (res.ok && res.data.state === 'ready' && res.data.loaded_model_id) {
              await streamResponse(convId!, res.data.loaded_model_id, '/models/chat', {
                messages: messagesWithMemory,
                stream: true,
              });
            } else {
              showNoModelMessage(convId!);
            }
          } catch {
            showNoModelMessage(convId!);
          }
          return;
        }

        if (model.source === 'local') {
          try {
            const res = await window.cerebro.invoke<{
              state: string;
              loaded_model_id: string | null;
            }>({ method: 'GET', path: '/models/status' });
            if (res.ok && res.data.state === 'ready' && res.data.loaded_model_id) {
              await streamResponse(convId!, model.displayName, '/models/chat', {
                messages: messagesWithMemory,
                stream: true,
              });
            } else {
              showNoModelMessage(convId!);
            }
          } catch {
            showNoModelMessage(convId!);
          }
        } else {
          // Cloud model — stream from /cloud/chat
          await streamResponse(convId!, model.displayName, '/cloud/chat', {
            provider: model.provider,
            model: model.modelId,
            messages: messagesWithMemory,
            stream: true,
          });
        }
      };

      // Assemble system prompt from memory, then dispatch
      (async () => {
        let messagesWithMemory = chatMessages;
        try {
          const systemPrompt = await getSystemPromptRef.current(chatMessages);
          if (systemPrompt) {
            messagesWithMemory = [
              { role: 'system', content: systemPrompt },
              ...chatMessages,
            ];
          }
        } catch {
          // Memory is non-critical — proceed without it
        }
        await dispatch(messagesWithMemory);
      })();
    },
    [activeConversationId, createConversation, addMessage, streamResponse, showNoModelMessage],
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
