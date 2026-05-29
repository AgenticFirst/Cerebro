/**
 * ChatFilePreviewContext — single global mount point for the chat file
 * preview modal. Any chat surface (main Cerebro chat, expert chat, etc.)
 * can call `useChatFilePreview().open(attachment, opts?)` to surface a
 * preview without threading modal state through every screen.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AttachmentInfo } from '../types/attachments';
import ChatFilePreviewModal from '../components/chat/ChatFilePreviewModal';

interface OpenOpts {
  conversationId?: string;
  messageId?: string;
  source?: 'user' | 'assistant';
}

interface ChatFilePreviewContextValue {
  open: (attachment: AttachmentInfo, opts?: OpenOpts) => void;
  close: () => void;
}

const ChatFilePreviewContext = createContext<ChatFilePreviewContextValue | null>(null);

interface PreviewState {
  attachment: AttachmentInfo;
  conversationId?: string;
  messageId?: string;
  source: 'user' | 'assistant';
}

export function ChatFilePreviewProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<PreviewState | null>(null);

  const open = useCallback((attachment: AttachmentInfo, opts?: OpenOpts) => {
    setCurrent({
      attachment,
      conversationId: opts?.conversationId,
      messageId: opts?.messageId,
      source: opts?.source ?? 'assistant',
    });
  }, []);

  const close = useCallback(() => setCurrent(null), []);

  const value = useMemo<ChatFilePreviewContextValue>(() => ({ open, close }), [open, close]);

  return (
    <ChatFilePreviewContext.Provider value={value}>
      {children}
      {current && (
        <ChatFilePreviewModal
          key={current.attachment.id}
          attachment={current.attachment}
          conversationId={current.conversationId}
          messageId={current.messageId}
          source={current.source}
          onClose={close}
        />
      )}
    </ChatFilePreviewContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useChatFilePreviewModal(): ChatFilePreviewContextValue {
  const ctx = useContext(ChatFilePreviewContext);
  if (!ctx) {
    throw new Error('useChatFilePreviewModal must be used inside ChatFilePreviewProvider');
  }
  return ctx;
}
