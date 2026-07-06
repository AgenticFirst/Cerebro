/**
 * Right pane — one conversation. Messages collapsed except the last; HTML
 * bodies render inside a fully sandboxed iframe (no scripts) so hostile email
 * markup can't touch the app. Opening a thread marks it read.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  ChevronDown,
  Clock,
  CornerUpLeft,
  Loader2,
  Paperclip,
  Sparkles,
} from 'lucide-react';
import clsx from 'clsx';
import {
  fetchThreadMessages,
  formatWhen,
  senderAddress,
  senderName,
  snoozeThread,
  type EmailMessage,
  type EmailThread,
} from './email-api';
import type { ComposeSeed } from './ComposeView';

interface Props {
  thread: EmailThread;
  onArchived: () => void;
  onSnoozed: () => void;
  onReply: (seed: ComposeSeed) => void;
}

function MessageBody({ msg }: { msg: EmailMessage }) {
  const [showHtml, setShowHtml] = useState(Boolean(msg.body_html && !msg.body_text));
  if (showHtml && msg.body_html) {
    return (
      <iframe
        sandbox=""
        srcDoc={`<base target="_blank"><style>body{font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#111;background:#fff;margin:12px;word-break:break-word}</style>${msg.body_html}`}
        className="w-full min-h-[240px] rounded-md border border-border-subtle bg-white"
        title="email"
      />
    );
  }
  return (
    <div>
      <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-text-primary">
        {msg.body_text || msg.snippet || ''}
      </pre>
      {msg.body_html && (
        <button
          onClick={() => setShowHtml(true)}
          className="mt-2 text-[11px] text-accent hover:underline cursor-pointer"
        >
          View formatted message
        </button>
      )}
    </div>
  );
}

function MessageCard({ msg, expanded: initialExpanded }: { msg: EmailMessage; expanded: boolean }) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(initialExpanded);
  useEffect(() => setExpanded(initialExpanded), [initialExpanded]);

  return (
    <div
      className={clsx(
        'rounded-lg border border-border-subtle',
        msg.is_outbound ? 'bg-accent/[0.04]' : 'bg-bg-surface/40',
      )}
    >
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left cursor-pointer"
      >
        <span
          className={clsx(
            'w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold shrink-0',
            msg.is_outbound ? 'bg-accent/20 text-accent' : 'bg-bg-elevated text-text-secondary',
          )}
        >
          {(senderName(msg.from_addr) || '?').slice(0, 1).toUpperCase()}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-[13px] font-medium text-text-primary truncate">
            {msg.is_outbound ? t('gmail.screen.you') : senderName(msg.from_addr)}
            <span className="ml-2 text-[11px] font-normal text-text-tertiary">
              {senderAddress(msg.from_addr)}
            </span>
          </span>
          {!expanded && (
            <span className="block text-[12px] text-text-tertiary truncate">{msg.snippet}</span>
          )}
        </span>
        {msg.has_attachments && <Paperclip size={12} className="text-text-tertiary shrink-0" />}
        <span className="text-[11px] text-text-tertiary shrink-0">
          {formatWhen(msg.internal_date, i18n.language)}
        </span>
        <ChevronDown
          size={13}
          className={clsx('text-text-tertiary transition-transform', expanded && 'rotate-180')}
        />
      </button>
      {expanded && (
        <div className="px-3.5 pb-3.5">
          {msg.to_addrs && (
            <div className="text-[11px] text-text-tertiary mb-2">
              {t('gmail.screen.toLine')} {msg.to_addrs}
            </div>
          )}
          <MessageBody msg={msg} />
          {msg.attachments.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {msg.attachments.map((a) => (
                <span
                  key={a.attachmentId}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-border-subtle bg-bg-surface text-[11px] text-text-secondary"
                >
                  <Paperclip size={10} /> {a.filename}
                  <span className="text-text-tertiary">{(a.sizeBytes / 1024).toFixed(0)} KB</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ThreadView({ thread, onArchived, onSnoozed, onReply }: Props) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<EmailMessage[] | null>(null);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(thread.ai_summary);

  useEffect(() => {
    let cancelled = false;
    setMessages(null);
    setSnoozeOpen(false);
    setSummary(thread.ai_summary);
    void fetchThreadMessages(thread.thread_id).then((msgs) => {
      if (cancelled) return;
      setMessages(msgs);
      // Mark unread messages read — local UI action, syncs back to Gmail.
      const unread = msgs.filter((m) => m.is_unread).map((m) => m.message_id);
      if (unread.length) {
        void window.cerebro.gmail.modifyLabels(unread, [], ['UNREAD']);
      }
      // Superhuman-style lazy summary: compute + cache on first open.
      if (!thread.ai_summary && msgs.length > 1) {
        void window.cerebro.gmail.summarizeThread(thread.thread_id).then((r) => {
          if (!cancelled && r.ok && r.summary) setSummary(r.summary);
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [thread.thread_id, thread.ai_summary]);

  const lastInbound = useMemo(
    () => [...(messages ?? [])].reverse().find((m) => !m.is_outbound),
    [messages],
  );

  const archive = async () => {
    if (!messages || busy) return;
    setBusy(true);
    await window.cerebro.gmail.modifyLabels(
      messages.map((m) => m.message_id),
      [],
      ['INBOX'],
    );
    setBusy(false);
    onArchived();
  };

  const snooze = async (until: Date) => {
    setSnoozeOpen(false);
    await snoozeThread(thread.id, until.toISOString());
    onSnoozed();
  };

  const snoozeOptions = (): Array<{ label: string; when: Date }> => {
    const now = new Date();
    const laterToday = new Date(now.getTime() + 3 * 3600_000);
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    const nextWeek = new Date(now);
    nextWeek.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
    nextWeek.setHours(9, 0, 0, 0);
    return [
      { label: t('gmail.screen.snooze.laterToday'), when: laterToday },
      { label: t('gmail.screen.snooze.tomorrow'), when: tomorrow },
      { label: t('gmail.screen.snooze.nextWeek'), when: nextWeek },
    ];
  };

  const reply = () => {
    onReply({
      to: lastInbound ? senderAddress(lastInbound.from_addr) : '',
      subject: thread.subject ?? '',
      replyToThreadId: thread.thread_id,
    });
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 px-4 py-2 border-b border-border-subtle">
        <h2 className="flex-1 min-w-0 text-[14px] font-semibold text-text-primary truncate">
          {thread.subject || t('gmail.screen.noSubject')}
        </h2>
        <button
          onClick={reply}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] bg-accent/15 text-accent hover:bg-accent/25 cursor-pointer"
        >
          <CornerUpLeft size={11} /> {t('gmail.screen.actions.reply')}
        </button>
        <button
          onClick={() => void archive()}
          disabled={busy}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] text-text-secondary hover:bg-bg-hover disabled:opacity-50 cursor-pointer"
        >
          <Archive size={11} /> {t('gmail.screen.actions.archive')}
        </button>
        <div className="relative">
          <button
            onClick={() => setSnoozeOpen((o) => !o)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] text-text-secondary hover:bg-bg-hover cursor-pointer"
          >
            <Clock size={11} /> {t('gmail.screen.actions.snooze')}
          </button>
          {snoozeOpen && (
            <div className="absolute right-0 top-full mt-1 z-20 w-44 rounded-md border border-border-subtle bg-bg-elevated shadow-xl py-1">
              {snoozeOptions().map((opt) => (
                <button
                  key={opt.label}
                  onClick={() => void snooze(opt.when)}
                  className="w-full text-left px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover cursor-pointer"
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* AI summary strip (computed lazily on first open, then cached) */}
      {summary && (
        <div className="flex items-start gap-2 px-4 py-2 border-b border-border-subtle bg-accent/[0.03]">
          <Sparkles size={12} className="text-accent mt-0.5 shrink-0" />
          <p className="text-[12px] text-text-secondary leading-relaxed">{summary}</p>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {messages === null && (
          <div className="flex items-center justify-center py-10 text-text-tertiary">
            <Loader2 size={18} className="animate-spin" />
          </div>
        )}
        {messages?.map((m, i) => (
          <MessageCard key={m.id} msg={m} expanded={i === messages.length - 1} />
        ))}
        {messages !== null && messages.length === 0 && (
          <p className="text-[12px] text-text-tertiary text-center py-10">
            {t('gmail.screen.threadNotSynced')}
          </p>
        )}
      </div>
    </div>
  );
}
