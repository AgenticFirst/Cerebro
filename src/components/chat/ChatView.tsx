import { useEffect, useRef, useState } from 'react';
import type { Conversation } from '../../types/chat';
import MessageList from './MessageList';
import ChatInput, { type ChatInputHandle } from './ChatInput';
import SandboxBanner from './SandboxBanner';
import { useDropZone } from '../../hooks/useDropZone';
import { useChat } from '../../context/ChatContext';
import { TelegramIcon } from '../icons/BrandIcons';
import { loadSetting } from '../../lib/settings';

interface ChatViewProps {
  conversation: Conversation;
  onSend: (content: string) => void;
  isStreaming: boolean;
  isThinking: boolean;
}

export default function ChatView({ conversation, onSend, isStreaming, isThinking }: ChatViewProps) {
  const chatInputRef = useRef<ChatInputHandle>(null);
  const { setActiveExpertId } = useChat();
  const [telegramUsername, setTelegramUsername] = useState<string | null>(null);

  // The main Chat screen always talks to Cerebro. If the user just came back
  // from the Experts > Messages tab, clear any expert that was pinned there.
  useEffect(() => {
    setActiveExpertId(null);
  }, [conversation.id, setActiveExpertId]);

  // Resolve @username for the Telegram badge from the bridge's username map
  // (populated by inbound messages). Best-effort — falls back to the chat id.
  useEffect(() => {
    if (conversation.source !== 'telegram' || !conversation.externalChatId) {
      setTelegramUsername(null);
      return;
    }
    let cancelled = false;
    loadSetting<Record<string, string>>('telegram_chat_username_map').then((map) => {
      if (cancelled) return;
      setTelegramUsername(map?.[conversation.externalChatId!] ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [conversation.source, conversation.externalChatId]);

  const { isDragOver, dropProps } = useDropZone({
    onDrop: (files) => chatInputRef.current?.addAttachments(files),
  });

  const isTelegram = conversation.source === 'telegram';
  const telegramLabel = telegramUsername
    ? `@${telegramUsername}`
    : conversation.externalChatId ?? 'unknown chat';

  return (
    <div className="flex-1 flex flex-col min-h-0 relative" {...dropProps}>
      <SandboxBanner />
      {isTelegram && (
        <div className="px-4 py-2 border-b border-white/[0.05] flex items-center gap-2 text-xs text-text-tertiary">
          <TelegramIcon size={14} className="text-sky-400/80" />
          <span>Telegram · {telegramLabel}</span>
        </div>
      )}
      <MessageList messages={conversation.messages} conversationId={conversation.id} />
      <div className="px-4 pb-4">
        <div className="mx-auto max-w-3xl">
          <ChatInput ref={chatInputRef} onSend={onSend} isStreaming={isStreaming} />
        </div>
      </div>

      {isDragOver && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-accent/5 border-2 border-dashed border-accent/40 rounded-xl pointer-events-none">
          <span className="text-sm font-medium text-accent">Drop files to attach</span>
        </div>
      )}
    </div>
  );
}
