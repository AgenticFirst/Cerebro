import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { MessagesSquare } from 'lucide-react';
import clsx from 'clsx';
import type { Expert } from '../../../../context/ExpertContext';
import { useChat } from '../../../../context/ChatContext';
import MessageList from '../../../chat/MessageList';
import ChatInput, { type ChatInputHandle } from '../../../chat/ChatInput';
import { useDropZone } from '../../../../hooks/useDropZone';
import ThreadHeader from './ThreadHeader';

interface ExpertThreadViewProps {
  expert: Expert | null;
  onOpenProfile: (expertId: string) => void;
}

export default function ExpertThreadView({ expert, onOpenProfile }: ExpertThreadViewProps) {
  const { t } = useTranslation();
  const {
    activeConversation,
    activeConversationId,
    isThinking,
    isStreaming,
    createConversation,
    setActiveConversation,
    setActiveExpertId,
    sendMessage,
    getConversationsForExpert,
  } = useChat();

  const chatInputRef = useRef<ChatInputHandle>(null);
  const { isDragOver, dropProps } = useDropZone({
    onDrop: (files) => chatInputRef.current?.addAttachments(files),
  });

  // Threads scoped to the currently-selected expert.
  const threads = useMemo(
    () => (expert ? getConversationsForExpert(expert.id) : []),
    [expert, getConversationsForExpert],
  );

  // When an expert is selected, sync global chat state: set activeExpertId so
  // sendMessage attributes the run, and select the most-recent thread (or
  // null for a fresh first-send).
  useEffect(() => {
    if (!expert) return;
    setActiveExpertId(expert.id);
    const current = threads.find((c) => c.id === activeConversationId);
    if (!current) {
      setActiveConversation(threads[0]?.id ?? null);
    }
    // We only want to re-run when the expert or thread list shape changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expert?.id, threads.length]);

  if (!expert) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-8 py-12">
        <div className="w-14 h-14 rounded-full bg-bg-elevated flex items-center justify-center mb-4">
          <MessagesSquare size={24} className="text-text-tertiary" />
        </div>
        <h2 className="text-[15px] font-semibold text-text-primary mb-1">
          {t('experts.messagesEmptyState')}
        </h2>
        <p className="text-[12px] text-text-tertiary max-w-sm">
          {t('experts.directMessages')}
        </p>
      </div>
    );
  }

  // Typing indicator: last assistant message in this thread is thinking/streaming.
  const lastMsg = activeConversation?.messages[activeConversation.messages.length - 1];
  const isTyping =
    !!activeConversation &&
    activeConversation.expertId === expert.id &&
    !!lastMsg &&
    lastMsg.role === 'assistant' &&
    (lastMsg.isThinking === true || lastMsg.isStreaming === true || isThinking || isStreaming);

  const handleNewThread = () => {
    const id = createConversation(undefined, { expertId: expert.id });
    setActiveConversation(id);
  };

  const handleSend = (content: string) => {
    // If we don't yet have an active thread for this expert, the first send
    // will auto-create one scoped to the expert (see ChatContext.sendMessage).
    sendMessage(content);
  };

  const showEmptyThread =
    !activeConversation || activeConversation.expertId !== expert.id;

  return (
    <div className="flex-1 flex flex-col min-h-0 relative" {...dropProps}>
      <ThreadHeader
        expert={expert}
        threads={threads}
        activeThreadId={activeConversationId}
        isTyping={isTyping}
        onSelectThread={(id) => setActiveConversation(id)}
        onNewThread={handleNewThread}
        onOpenProfile={() => onOpenProfile(expert.id)}
      />

      {showEmptyThread ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
          <div className="w-12 h-12 rounded-full bg-bg-elevated flex items-center justify-center mb-3">
            <MessagesSquare size={20} className="text-text-tertiary" />
          </div>
          <p className="text-[13px] text-text-secondary">
            {t('experts.noThreadsYet')}
          </p>
          <p className="text-[11px] text-text-tertiary mt-1 max-w-sm">
            {t('chat.sendPlaceholder')}
          </p>
        </div>
      ) : (
        <MessageList messages={activeConversation.messages} isThinking={isTyping} />
      )}

      <div className="px-4 pb-4 pt-2 bg-bg-base">
        <div className="mx-auto max-w-3xl">
          <ChatInput ref={chatInputRef} onSend={handleSend} isStreaming={isStreaming} />
        </div>
      </div>

      {isDragOver && (
        <div
          className={clsx(
            'absolute inset-0 z-20 flex items-center justify-center pointer-events-none',
            'bg-accent/5 border-2 border-dashed border-accent/40 rounded-xl',
          )}
        >
          <span className="text-sm font-medium text-accent">Drop files to attach</span>
        </div>
      )}
    </div>
  );
}
