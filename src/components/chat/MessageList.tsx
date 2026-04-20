import { lazy, Suspense, useRef, useEffect } from 'react';
import type { Message } from '../../types/chat';
import ChatMessage from './ChatMessage';

const ChatEmptyState = lazy(() => import('./ChatEmptyState'));

interface MessageListProps {
  messages: Message[];
  isThinking: boolean;
}

export default function MessageList({ messages, isThinking }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastMsg = messages[messages.length - 1];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, lastMsg?.content, isThinking]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto scrollbar-thin relative">
        <div className="mx-auto flex min-h-full max-w-3xl items-center justify-center">
          <Suspense fallback={null}>
            <ChatEmptyState />
          </Suspense>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin px-4 py-6">
      <div className="mx-auto max-w-3xl flex flex-col gap-6">
        {messages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
