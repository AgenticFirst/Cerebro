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
import type { BackendResponse } from '../types/ipc';
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

// Demo tool calls for simulation
const DEMO_TOOL_CALLS: Omit<ToolCall, 'id'>[] = [
  {
    name: 'search_knowledge',
    description: 'Searching knowledge base for relevant context',
    arguments: { query: 'user preferences and history' },
    output:
      'Found 3 relevant context entries:\n- User prefers concise responses\n- Previous conversation about project planning\n- Timezone: EST',
    status: 'success',
  },
  {
    name: 'analyze_intent',
    description: 'Analyzing request to determine best approach',
    arguments: { intent: 'general_question' },
    output:
      'Intent classified as: general conversation\nConfidence: 0.94\nRouting: direct response (no routine needed)',
    status: 'success',
  },
];

const DEMO_RESPONSE = `I'm **Cerebro**, your personal intelligence platform. Here's what I can help you with:

### Capabilities
- **Chat** with me or specialized experts for any task
- **Routines** — I can create reusable workflows from your requests
- **Memory** — I learn your preferences and context over time
- **Connections** — I work across your tools (calendar, email, docs)

### Getting Started
1. Just ask me anything in natural language
2. If I detect a repeatable task, I'll propose saving it as a routine
3. Check out the **Experts** tab to see available specialists

\`\`\`python
# Example: Creating a morning routine
routine = cerebro.create_routine(
    name="Morning Briefing",
    trigger="daily at 9am",
    steps=["check_calendar", "summarize_emails", "plan_day"]
)
\`\`\`

> **Tip:** You can also reach me through connected channels like Telegram or WhatsApp once Remote Access is configured.

What would you like to work on?`;

export function ChatProvider({ children }: { children: ReactNode }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationIdState] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [activeScreen, setActiveScreen] = useState<Screen>('chat');
  const abortRef = useRef<AbortController | null>(null);

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

  // Simulate a full assistant response cycle: thinking → tool calls → streaming
  const simulateResponse = useCallback(
    async (conversationId: string) => {
      const controller = new AbortController();
      abortRef.current = controller;
      const signal = controller.signal;

      const sleep = (ms: number) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });

      try {
        // Phase 1: Thinking
        setIsThinking(true);
        const assistantId = generateId();
        const thinkingMessage: Message = {
          id: assistantId,
          conversationId,
          role: 'assistant',
          content: '',
          createdAt: new Date(),
          isThinking: true,
          toolCalls: [],
        };
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

        await sleep(1500);
        if (signal.aborted) return;

        // Phase 2: Tool calls — add them one by one
        setIsThinking(false);
        const toolCalls: ToolCall[] = [];

        for (const demo of DEMO_TOOL_CALLS) {
          if (signal.aborted) return;
          const tc: ToolCall = {
            ...demo,
            id: generateId(),
            status: 'running',
            startedAt: new Date(),
          };
          toolCalls.push(tc);
          updateMessage(conversationId, assistantId, {
            isThinking: false,
            toolCalls: [...toolCalls],
          });
          await sleep(800);
          if (signal.aborted) return;

          // Complete the tool call
          tc.status = 'success';
          tc.completedAt = new Date();
          updateMessage(conversationId, assistantId, {
            toolCalls: [...toolCalls],
          });
          await sleep(400);
        }

        if (signal.aborted) return;

        // Phase 3: Streaming text
        setIsStreaming(true);
        updateMessage(conversationId, assistantId, {
          isStreaming: true,
          toolCalls: [...toolCalls],
        });

        const words = DEMO_RESPONSE.split(/(\s+)/);
        let accumulated = '';
        const chunkSize = 3;

        for (let i = 0; i < words.length; i += chunkSize) {
          if (signal.aborted) return;
          accumulated += words.slice(i, i + chunkSize).join('');
          updateMessage(conversationId, assistantId, { content: accumulated });
          await sleep(30);
        }

        // Done
        updateMessage(conversationId, assistantId, {
          content: DEMO_RESPONSE,
          isStreaming: false,
        });
        apiCreateMessage(conversationId, {
          id: assistantId,
          role: 'assistant',
          content: DEMO_RESPONSE,
        }).catch(console.error);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        throw e;
      } finally {
        setIsStreaming(false);
        setIsThinking(false);
        abortRef.current = null;
      }
    },
    [updateMessage],
  );

  const sendMessage = useCallback(
    (content: string) => {
      let convId = activeConversationId;
      if (!convId) {
        convId = createConversation(content);
      }
      addMessage(convId, 'user', content);
      simulateResponse(convId);
    },
    [activeConversationId, createConversation, addMessage, simulateResponse],
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
