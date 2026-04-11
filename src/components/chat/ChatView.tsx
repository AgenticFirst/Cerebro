import type { Conversation } from '../../types/chat';
import MessageList from './MessageList';
import ChatInput from './ChatInput';
import SandboxBanner from './SandboxBanner';

interface ChatViewProps {
  conversation: Conversation;
  onSend: (content: string) => void;
  isStreaming: boolean;
  isThinking: boolean;
}

export default function ChatView({ conversation, onSend, isStreaming, isThinking }: ChatViewProps) {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <SandboxBanner />
      <MessageList messages={conversation.messages} isThinking={isThinking} />
      <div className="px-4 pb-4">
        <div className="mx-auto max-w-3xl">
          <ChatInput onSend={onSend} isStreaming={isStreaming} />
        </div>
      </div>
    </div>
  );
}
