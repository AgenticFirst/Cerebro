import {
  Fragment,
  lazy,
  Suspense,
  useRef,
  useLayoutEffect,
  useCallback,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { Message } from '../../types/chat';
import ChatMessage from './ChatMessage';
import { dayDividerLabel, isSameLocalDay } from '../../context/chat-helpers';

function MessageDayDivider({ date }: { date: Date }) {
  const { t, i18n } = useTranslation();
  const label = dayDividerLabel(date, new Date(), i18n.language);
  const text = 'key' in label ? t(`timeGroups.${label.key}`) : label.text;
  return (
    <div className="flex items-center gap-3 select-none" role="separator" aria-label={text}>
      <div className="h-px flex-1 bg-border-subtle" />
      <span className="text-[10px] font-semibold text-text-tertiary/70 uppercase tracking-[0.1em]">
        {text}
      </span>
      <div className="h-px flex-1 bg-border-subtle" />
    </div>
  );
}

const ChatEmptyState = lazy(() => import('./ChatEmptyState'));

interface MessageListProps {
  messages: Message[];
  conversationId: string;
  /** Rendered at the end of the scrollable stream, after the last message. */
  footer?: ReactNode;
}

export default function MessageList({ messages, conversationId, footer }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const messageNodes = useRef(new Map<string, HTMLDivElement>());
  const prevConvIdRef = useRef<string | null>(null);
  const prevLenRef = useRef(0);

  const setMessageNode = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      if (el) messageNodes.current.set(id, el);
      else messageNodes.current.delete(id);
    },
    [],
  );

  useLayoutEffect(() => {
    const container = containerRef.current;
    const prevConvId = prevConvIdRef.current;
    const prevLen = prevLenRef.current;
    const len = messages.length;

    const conversationChanged = prevConvId !== conversationId;
    const appended = !conversationChanged && len > prevLen;

    if (conversationChanged) {
      if (container) container.scrollTop = container.scrollHeight;
    } else if (appended) {
      // Anchor the most recent user message at the top of the viewport so the
      // question stays visible while the answer streams in below it. Falls back
      // to the new last message if there's no user message yet.
      let anchorIdx = len - 1;
      for (let i = len - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          anchorIdx = i;
          break;
        }
      }
      const anchor = messages[anchorIdx];
      const node = anchor ? messageNodes.current.get(anchor.id) : undefined;
      node?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    prevConvIdRef.current = conversationId;
    prevLenRef.current = len;
  }, [messages.length, conversationId]);

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
    <div ref={containerRef} className="flex-1 overflow-y-auto scrollbar-thin px-4 py-6">
      <div className="mx-auto max-w-3xl flex flex-col gap-6">
        {messages.map((msg, i) => {
          const prev = messages[i - 1];
          const newDay = !prev || !isSameLocalDay(prev.createdAt, msg.createdAt);
          return (
            <Fragment key={msg.id}>
              {newDay && <MessageDayDivider date={msg.createdAt} />}
              <ChatMessage message={msg} nodeRef={setMessageNode(msg.id)} />
            </Fragment>
          );
        })}
        {footer}
      </div>
    </div>
  );
}
