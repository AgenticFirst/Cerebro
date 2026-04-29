import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Copy, Check } from 'lucide-react';
import clsx from 'clsx';
import type { Message } from '../../types/chat';
import MarkdownContent from './MarkdownContent';
import ThinkingIndicator from './ThinkingIndicator';
import ToolCallsGroup from './ToolCallsGroup';
import RunLogCard from './RunLogCard';
import RoutineProposalCard from './RoutineProposalCard';
import IntegrationSetupCard from './IntegrationSetupCard';
import ExpertProposalCard from './ExpertProposalCard';
import TeamProposalCard from './TeamProposalCard';
import TeamRunCard from './TeamRunCard';
import AttachmentChip from './AttachmentChip';
import {
  parseFileRefs,
  parseTrailingFileRefs,
  getCopyableContent,
} from '../../lib/message-content';
import { useCopyMessage } from '../../hooks/useCopyMessage';

interface ChatMessageProps {
  message: Message;
  nodeRef?: (el: HTMLDivElement | null) => void;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function ChatMessage({ message, nodeRef }: ChatMessageProps) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  const hasToolCalls = message.toolCalls && message.toolCalls.length > 0;

  // Parsing is O(N) per render and streaming re-renders this every chunk, so
  // cache on the content string.
  const { fileRefs, displayContent, copyableMarkdown } = useMemo(() => {
    if (isUser) {
      const { attachments, text } = parseFileRefs(message.content);
      return { fileRefs: attachments, displayContent: text, copyableMarkdown: text };
    }
    const { attachments, text } = parseTrailingFileRefs(message.content);
    return {
      fileRefs: attachments,
      displayContent: text,
      copyableMarkdown: getCopyableContent({ role: 'assistant', content: message.content }),
    };
  }, [isUser, message.content]);

  const hasContent = displayContent.length > 0;
  const assistantBusy =
    !isUser && (message.isThinking || message.isStreaming === true) && !hasContent;

  const { copied, copy } = useCopyMessage();
  const canCopy = copyableMarkdown.length > 0 && !message.isStreaming;

  return (
    <div
      ref={nodeRef}
      className="group animate-fade-in"
      data-testid="chat-message"
      data-role={isUser ? 'user' : 'assistant'}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className={clsx('text-xs font-medium', isUser ? 'text-accent' : 'text-text-secondary')}
        >
          {isUser ? t('chat.you') : t('chat.cerebro')}
        </span>
        <span className="text-xs text-text-tertiary">{formatTime(message.createdAt)}</span>
      </div>

      {/* Tool calls (before text content) — hidden by default, user can opt in via Settings → Appearance */}
      {hasToolCalls && (
        <ToolCallsGroup toolCalls={message.toolCalls!} isBusy={assistantBusy} />
      )}

      {/* Run log card */}
      {!isUser && message.engineRunId && (
        <div className="mb-2">
          <RunLogCard engineRunId={message.engineRunId} isPreview={message.isPreviewRun} />
        </div>
      )}

      {/* Routine proposal card */}
      {!isUser && message.routineProposal && (
        <div className="mb-2">
          <RoutineProposalCard
            proposal={message.routineProposal}
            messageId={message.id}
            conversationId={message.conversationId}
          />
        </div>
      )}

      {/* Integration setup proposal card */}
      {!isUser && message.integrationProposal && (
        <div className="mb-2">
          <IntegrationSetupCard
            proposal={message.integrationProposal}
            messageId={message.id}
            conversationId={message.conversationId}
          />
        </div>
      )}

      {/* Team proposal card */}
      {!isUser && message.teamProposal && (
        <div className="mb-2">
          <TeamProposalCard
            proposal={message.teamProposal}
            messageId={message.id}
            conversationId={message.conversationId}
          />
        </div>
      )}

      {/* Team run card */}
      {!isUser && message.teamRun && (
        <div className="mb-2">
          <TeamRunCard teamRun={message.teamRun} />
        </div>
      )}

      {/* Expert proposal card */}
      {!isUser && message.expertProposal && (
        <div className="mb-2">
          <ExpertProposalCard
            proposal={message.expertProposal}
            messageId={message.id}
            conversationId={message.conversationId}
          />
        </div>
      )}

      {/* Thinking indicator — only when there are no tool calls; otherwise the
          ToolCallsGroup already surfaces a live "Working on it..." signal. */}
      {!isUser && message.isThinking && !hasContent && !hasToolCalls && <ThinkingIndicator />}

      {/* File attachments for user messages */}
      {isUser && fileRefs.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {fileRefs.map((att) => (
            <AttachmentChip key={att.id} attachment={att} source="user" conversationId={message.conversationId} messageId={message.id} />
          ))}
        </div>
      )}

      {/* Message content */}
      {hasContent && (
        <div
          className={clsx(
            'rounded-xl px-4 py-3',
            isUser ? 'bg-accent-muted text-text-primary' : 'text-text-secondary',
          )}
        >
          {isUser ? (
            <p className="text-sm whitespace-pre-wrap leading-relaxed">{displayContent}</p>
          ) : (
            <MarkdownContent content={displayContent} />
          )}
        </div>
      )}

      {/* Streaming indicator — shown while the assistant is still composing its
          reply after text has started arriving. Replaces the old blinking
          cursor with a live "Working on it..." pill that mirrors the tool-call
          group style so the UI speaks one consistent language of progress. */}
      {!isUser && message.isStreaming && hasContent && (
        <div className="mt-2 animate-fade-in">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/[0.06] text-accent px-2.5 py-1 text-[11px] font-medium">
            <Loader2 size={10} className="animate-spin flex-shrink-0" />
            <span className="tracking-tight">
              {t('toolCall.workingOnIt')}
            </span>
          </span>
        </div>
      )}

      {/* File attachments emitted by the expert */}
      {!isUser && fileRefs.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {fileRefs.map((att) => (
            <AttachmentChip key={att.id} attachment={att} source="assistant" conversationId={message.conversationId} messageId={message.id} />
          ))}
        </div>
      )}

      {/* Actions row — hover-reveal, mirrors bubble alignment. Copy is the only
          action today; the row is structured so regenerate/thumbs can slot in
          later without re-plumbing hover state. */}
      {canCopy && (
        <div
          className={clsx(
            'mt-1.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-150',
            'group-hover:opacity-100 focus-within:opacity-100',
            isUser ? 'justify-start' : 'justify-end',
          )}
        >
          <button
            type="button"
            onClick={() => copy(copyableMarkdown)}
            className="flex items-center justify-center w-7 h-7 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
            title={copied ? t('chat.copied') : t('chat.copyMessage')}
            aria-label={copied ? t('chat.copied') : t('chat.copyMessage')}
          >
            {copied ? (
              <Check size={13} className="text-accent" strokeWidth={2.25} />
            ) : (
              <Copy size={13} strokeWidth={2} />
            )}
          </button>
        </div>
      )}
    </div>
  );
}
