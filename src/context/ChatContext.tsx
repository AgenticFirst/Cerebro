import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from 'react';
import type { Conversation, Message, Screen, ToolCall } from '../types/chat';

interface ChatState {
  conversations: Conversation[];
  activeConversationId: string | null;
  isStreaming: boolean;
  isThinking: boolean;
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

type ChatContextValue = ChatState & ChatActions & {
  activeConversation: Conversation | undefined;
};

const ChatContext = createContext<ChatContextValue | null>(null);

function generateId(): string {
  return crypto.randomUUID();
}

function titleFromContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= 40) return trimmed;
  return trimmed.slice(0, 40) + '...';
}

// Demo tool calls for simulation
const DEMO_TOOL_CALLS: Omit<ToolCall, 'id'>[] = [
  {
    name: 'search_knowledge',
    description: 'Searching knowledge base for relevant context',
    arguments: { query: 'user preferences and history' },
    output: 'Found 3 relevant context entries:\n- User prefers concise responses\n- Previous conversation about project planning\n- Timezone: EST',
    status: 'success',
  },
  {
    name: 'analyze_intent',
    description: 'Analyzing request to determine best approach',
    arguments: { intent: 'general_question' },
    output: 'Intent classified as: general conversation\nConfidence: 0.94\nRouting: direct response (no routine needed)',
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
  const [activeScreen, setActiveScreen] = useState<Screen>('chat');
  const abortRef = useRef<AbortController | null>(null);

  const createConversation = useCallback((firstMessage?: string) => {
    const id = generateId();
    const now = new Date();
    const conversation: Conversation = {
      id,
      title: firstMessage ? titleFromContent(firstMessage) : 'New conversation',
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    setConversations((prev) => [conversation, ...prev]);
    setActiveConversationIdState(id);
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
            ? { ...c, messages: [...c.messages, message], updatedAt: new Date() }
            : c,
        ),
      );
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
                messages: c.messages.map((m) =>
                  m.id === messageId ? { ...m, ...partial } : m,
                ),
              }
            : c,
        ),
      );
    },
    [],
  );

  const deleteConversation = useCallback(
    (id: string) => {
      setConversations((prev) => prev.filter((c) => c.id !== id));
      setActiveConversationIdState((current) => (current === id ? null : current));
    },
    [],
  );

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
              ? { ...c, messages: [...c.messages, thinkingMessage], updatedAt: new Date() }
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
          const tc: ToolCall = { ...demo, id: generateId(), status: 'running', startedAt: new Date() };
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
