import { useRef, useEffect } from 'react';
import type { Message } from '../../types/chat';
import ChatMessage from './ChatMessage';
import ThinkingIndicator from './ThinkingIndicator';

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

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin px-4 py-6">
      <div className="mx-auto max-w-3xl flex flex-col gap-6">
        {messages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} />
        ))}
        {isThinking && <ThinkingIndicator />}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
