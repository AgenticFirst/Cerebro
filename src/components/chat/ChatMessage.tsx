import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import clsx from 'clsx';
import type { Message } from '../../types/chat';
import MarkdownContent from './MarkdownContent';
import ThinkingIndicator from './ThinkingIndicator';
import ToolCallsGroup from './ToolCallsGroup';
import RunLogCard from './RunLogCard';
import RoutineProposalCard from './RoutineProposalCard';
import ExpertProposalCard from './ExpertProposalCard';
import TeamProposalCard from './TeamProposalCard';
import TeamRunCard from './TeamRunCard';
import AttachmentChip from './AttachmentChip';
import type { AttachmentInfo } from '../../types/attachments';

interface ChatMessageProps {
  message: Message;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function parseFileRefs(content: string): { attachments: AttachmentInfo[]; text: string } {
  const lines = content.split('\n');
  const attachments: AttachmentInfo[] = [];
  let i = 0;

  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('@/') || line.startsWith('@~')) {
      const filePath = line.slice(1);
      const fileName = filePath.split('/').pop() || filePath;
      const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
      attachments.push({ id: filePath, filePath, fileName, fileSize: 0, extension: ext });
    } else if (line === '') {
      continue;
    } else {
      break;
    }
  }

  return { attachments, text: lines.slice(i).join('\n').trim() };
}

function parseTrailingFileRefs(content: string): { attachments: AttachmentInfo[]; text: string } {
  const lines = content.split('\n');
  const attachments: AttachmentInfo[] = [];
  let cut = lines.length;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('@/') || line.startsWith('@~')) {
      const filePath = line.slice(1);
      const fileName = filePath.split('/').pop() || filePath;
      const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
      attachments.unshift({ id: filePath, filePath, fileName, fileSize: 0, extension: ext });
      cut = i;
    } else if (line === '') {
      continue;
    } else {
      break;
    }
  }

  return { attachments, text: lines.slice(0, cut).join('\n').trimEnd() };
}

export default function ChatMessage({ message }: ChatMessageProps) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  const hasToolCalls = message.toolCalls && message.toolCalls.length > 0;

  const { attachments: userFileRefs, text: userText } = isUser
    ? parseFileRefs(message.content)
    : { attachments: [], text: '' };
  const { attachments: assistantFileRefs, text: assistantText } = !isUser
    ? parseTrailingFileRefs(message.content)
    : { attachments: [], text: '' };
  const fileRefs = isUser ? userFileRefs : assistantFileRefs;
  const displayContent = isUser ? userText : assistantText;

  const hasContent = displayContent.length > 0;
  // Assistant is still producing its reply — keep a live indicator visible even
  // when all tool calls have finished but no text has arrived yet.
  const assistantBusy =
    !isUser && (message.isThinking || message.isStreaming === true) && !hasContent;

  return (
    <div className="animate-fade-in">
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
            <AttachmentChip key={att.id} attachment={att} source="user" />
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
            <AttachmentChip key={att.id} attachment={att} source="assistant" />
          ))}
        </div>
      )}

    </div>
  );
}
