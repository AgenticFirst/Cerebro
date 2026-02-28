import clsx from 'clsx';
import type { Message } from '../../types/chat';
import MarkdownContent from './MarkdownContent';

interface ChatMessageProps {
  message: Message;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === 'user';

  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-2 mb-1.5">
        <span className={clsx(
          'text-xs font-medium',
          isUser ? 'text-accent' : 'text-text-secondary',
        )}>
          {isUser ? 'You' : 'Cerebro'}
        </span>
        <span className="text-xs text-text-tertiary">
          {formatTime(message.createdAt)}
        </span>
      </div>
      <div
        className={clsx(
          'rounded-xl px-4 py-3',
          isUser
            ? 'bg-accent-muted text-text-primary'
            : 'text-text-secondary',
        )}
      >
        {isUser ? (
          <p className="text-sm whitespace-pre-wrap leading-relaxed">{message.content}</p>
        ) : (
          <div className={clsx(message.isStreaming && 'streaming-cursor')}>
            <MarkdownContent content={message.content} />
          </div>
        )}
      </div>
    </div>
  );
}
