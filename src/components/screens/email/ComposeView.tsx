/**
 * Compose panel — new email or in-thread reply. Sends through
 * window.cerebro.gmail.send (main process; the human clicking Send here IS the
 * approval, so no gate applies). Cmd/Ctrl+Enter sends.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookMarked, ChevronDown, Clock, Loader2, Send, FileText, Sparkles, X } from 'lucide-react';
import { splitAddresses } from '../../../gmail/helpers';

interface EmailTemplate {
  id: string;
  name: string;
  subject_template: string | null;
  body_template: string;
  variables: string[];
}

/** Unfilled {{tokens}} left in the text (fallback-less). */
function unresolvedTokens(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) out.add(m[1]);
  return [...out];
}

export interface ComposeSeed {
  to?: string;
  subject?: string;
  body?: string;
  replyToThreadId?: string;
}

interface Props {
  seed: ComposeSeed;
  onClose: () => void;
  onSent: () => void;
}

export default function ComposeView({ seed, onClose, onSent }: Props) {
  const { t } = useTranslation();
  const [to, setTo] = useState(seed.to ?? '');
  const [cc, setCc] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState(seed.subject ?? '');
  const [body, setBody] = useState(seed.body ?? '');
  const [sending, setSending] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const isReply = Boolean(seed.replyToThreadId);

  useEffect(() => {
    void window.cerebro
      .invoke<{ templates: EmailTemplate[] }>({ method: 'GET', path: '/gmail/templates' })
      .then((r) => {
        if (r.ok && r.data) setTemplates(r.data.templates);
      });
  }, []);

  useEffect(() => {
    // Replies land in the body; new mail starts at "to".
    if (isReply) bodyRef.current?.focus();
  }, [isReply]);

  // Templates insert {{tokens}} literally; sending is blocked until the user
  // fills every one (HubSpot-style force-fill — no "Hi {{first_name}}" ships).
  const pendingTokens = [...unresolvedTokens(subject), ...unresolvedTokens(body)];
  const canSend =
    splitAddresses(to).length > 0 &&
    body.trim().length > 0 &&
    !sending &&
    pendingTokens.length === 0;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    const res = await window.cerebro.gmail.send({
      to: splitAddresses(to),
      cc: showCc ? splitAddresses(cc) : undefined,
      subject: subject.trim(),
      text: body,
      replyToThreadId: seed.replyToThreadId,
    });
    setSending(false);
    if (res.ok) {
      onSent();
      onClose();
    } else {
      setError(res.error ?? 'Send failed');
    }
  };

  const saveDraft = async () => {
    if (!splitAddresses(to).length || savingDraft) return;
    setSavingDraft(true);
    setError(null);
    const res = await window.cerebro.gmail.createDraft({
      to: splitAddresses(to),
      cc: showCc ? splitAddresses(cc) : undefined,
      subject: subject.trim(),
      text: body,
      replyToThreadId: seed.replyToThreadId,
    });
    setSavingDraft(false);
    if (res.ok) onClose();
    else setError(res.error ?? 'Draft failed');
  };

  /**
   * "Write with AI": the current body text is treated as the instruction
   * ("tell them we accept, ask about timing") — or, when empty on a reply,
   * the AI just writes the natural next reply. Output replaces the body,
   * drafted in the user's own voice from their sent mail.
   */
  const aiDraft = async () => {
    if (drafting) return;
    setDrafting(true);
    setError(null);
    const res = await window.cerebro.gmail.aiDraft({
      to,
      instruction: body.trim(),
      replyToThreadId: seed.replyToThreadId,
    });
    setDrafting(false);
    if (res.ok && res.body) {
      setBody(res.body);
      bodyRef.current?.focus();
    } else {
      setError(res.error ?? 'Draft failed');
    }
  };

  const applyTemplate = (tpl: EmailTemplate) => {
    setTemplatesOpen(false);
    if (tpl.subject_template && !isReply) setSubject(tpl.subject_template);
    setBody(tpl.body_template);
    bodyRef.current?.focus();
  };

  const saveAsTemplate = async () => {
    if (!body.trim() || savingTemplate) return;
    const name = subject.trim() || `Template ${new Date().toLocaleDateString()}`;
    setSavingTemplate(true);
    const r = await window.cerebro.invoke<EmailTemplate>({
      method: 'POST',
      path: '/gmail/templates',
      body: { name, subject_template: subject.trim(), body_template: body },
    });
    setSavingTemplate(false);
    if (r.ok && r.data) setTemplates((prev) => [...prev, r.data as EmailTemplate]);
  };

  const scheduleSend = async (when: Date) => {
    setScheduleOpen(false);
    if (!splitAddresses(to).length || !body.trim() || pendingTokens.length) return;
    setSending(true);
    setError(null);
    const status = await window.cerebro.gmail.status();
    const accountId = status.accounts[0]?.id;
    if (!accountId) {
      setSending(false);
      setError('No account');
      return;
    }
    const r = await window.cerebro.invoke({
      method: 'POST',
      path: '/gmail/scheduled-sends',
      body: {
        account_id: accountId,
        to_addrs: to,
        cc_addrs: showCc ? cc : '',
        subject: subject.trim(),
        body_text: body,
        reply_to_thread_id: seed.replyToThreadId ?? '',
        send_at: when.toISOString(),
      },
    });
    setSending(false);
    if (r.ok) {
      onSent();
      onClose();
    } else {
      setError('Scheduling failed');
    }
  };

  const scheduleOptions = (): Array<{ label: string; when: Date }> => {
    const now = new Date();
    const inTwoHours = new Date(now.getTime() + 2 * 3600_000);
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    const monday = new Date(now);
    monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
    monday.setHours(9, 0, 0, 0);
    return [
      { label: t('gmail.screen.schedule.inTwoHours'), when: inTwoHours },
      { label: t('gmail.screen.schedule.tomorrowMorning'), when: tomorrow },
      { label: t('gmail.screen.schedule.mondayMorning'), when: monday },
    ];
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void send();
    }
    if (e.key === 'Escape') onClose();
  };

  const inputCls =
    'w-full bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-tertiary';

  return (
    <div className="absolute bottom-4 right-4 z-30 w-[560px] max-w-[calc(100vw-2rem)] rounded-xl border border-border-subtle bg-bg-base shadow-2xl flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-subtle bg-bg-surface/50">
        <span className="flex-1 text-[13px] font-semibold text-text-primary">
          {isReply ? t('gmail.screen.compose.replyTitle') : t('gmail.screen.compose.title')}
        </span>
        <button
          onClick={onClose}
          className="text-text-tertiary hover:text-text-secondary cursor-pointer"
        >
          <X size={15} />
        </button>
      </div>

      <div className="px-4 py-1 border-b border-border-subtle flex items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide text-text-tertiary w-8">
          {t('gmail.screen.compose.to')}
        </span>
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="alice@example.com, bob@example.com"
          className={`${inputCls} py-1.5`}
        />
        {!showCc && (
          <button
            onClick={() => setShowCc(true)}
            className="text-[11px] text-text-tertiary hover:text-text-secondary cursor-pointer"
          >
            Cc
          </button>
        )}
      </div>

      {showCc && (
        <div className="px-4 py-1 border-b border-border-subtle flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-text-tertiary w-8">Cc</span>
          <input
            value={cc}
            onChange={(e) => setCc(e.target.value)}
            onKeyDown={onKeyDown}
            className={`${inputCls} py-1.5`}
          />
        </div>
      )}

      {!isReply && (
        <div className="px-4 py-1 border-b border-border-subtle">
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('gmail.screen.compose.subject')}
            className={`${inputCls} py-1.5 font-medium`}
          />
        </div>
      )}

      <textarea
        ref={bodyRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t('gmail.screen.compose.bodyPlaceholder')}
        className={`${inputCls} px-4 py-3 min-h-[200px] resize-y leading-relaxed`}
      />

      {pendingTokens.length > 0 && (
        <div className="px-4 py-2 text-[11px] text-amber-400">
          {t('gmail.screen.compose.fillTokens')} {pendingTokens.map((v) => `{{${v}}}`).join(', ')}
        </div>
      )}
      {error && <div className="px-4 py-2 text-[12px] text-red-400">{error}</div>}

      <div className="flex items-center gap-1.5 px-4 py-2.5 border-t border-border-subtle bg-bg-surface/30">
        <button
          onClick={() => void send()}
          disabled={!canSend}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-[12px] font-medium bg-accent text-black hover:brightness-110 disabled:opacity-40 cursor-pointer"
        >
          {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
          {t('gmail.screen.compose.send')}
        </button>
        <div className="relative">
          <button
            onClick={() => setScheduleOpen((o) => !o)}
            disabled={!canSend}
            title={t('gmail.screen.compose.sendLater')}
            className="flex items-center gap-1 px-1.5 py-1.5 rounded-md text-[12px] bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-40 cursor-pointer"
          >
            <Clock size={12} />
            <ChevronDown size={10} />
          </button>
          {scheduleOpen && (
            <div className="absolute left-0 bottom-full mb-1 z-20 w-44 rounded-md border border-border-subtle bg-bg-elevated shadow-xl py-1">
              {scheduleOptions().map((opt) => (
                <button
                  key={opt.label}
                  onClick={() => void scheduleSend(opt.when)}
                  className="w-full text-left px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover cursor-pointer"
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={() => void saveDraft()}
          disabled={savingDraft || !splitAddresses(to).length}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] text-text-secondary hover:bg-bg-hover disabled:opacity-40 cursor-pointer"
        >
          {savingDraft ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />}
          {t('gmail.screen.compose.saveDraft')}
        </button>
        <button
          onClick={() => void aiDraft()}
          disabled={drafting || (!seed.replyToThreadId && !body.trim())}
          title={t('gmail.screen.compose.aiDraftHint')}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] text-accent hover:bg-accent/10 disabled:opacity-40 cursor-pointer"
        >
          {drafting ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          {t('gmail.screen.compose.aiDraft')}
        </button>
        <div className="relative">
          <button
            onClick={() => setTemplatesOpen((o) => !o)}
            title={t('gmail.screen.compose.templates')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] text-text-secondary hover:bg-bg-hover cursor-pointer"
          >
            <BookMarked size={12} />
            <ChevronDown size={10} />
          </button>
          {templatesOpen && (
            <div className="absolute left-0 bottom-full mb-1 z-20 w-56 max-h-64 overflow-y-auto rounded-md border border-border-subtle bg-bg-elevated shadow-xl py-1">
              {templates.map((tpl) => (
                <button
                  key={tpl.id}
                  onClick={() => applyTemplate(tpl)}
                  className="w-full text-left px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover cursor-pointer truncate"
                >
                  {tpl.name}
                </button>
              ))}
              {templates.length === 0 && (
                <p className="px-3 py-1.5 text-[11px] text-text-tertiary">
                  {t('gmail.screen.compose.noTemplates')}
                </p>
              )}
              <div className="border-t border-border-subtle mt-1 pt-1">
                <button
                  onClick={() => void saveAsTemplate()}
                  disabled={!body.trim() || savingTemplate}
                  className="w-full text-left px-3 py-1.5 text-[12px] text-accent hover:bg-bg-hover disabled:opacity-40 cursor-pointer"
                >
                  {savingTemplate
                    ? t('gmail.screen.compose.savingTemplate')
                    : t('gmail.screen.compose.saveAsTemplate')}
                </button>
              </div>
            </div>
          )}
        </div>
        <span className="ml-auto text-[10px] text-text-tertiary">
          ⌘↵ {t('gmail.screen.compose.send')}
        </span>
      </div>
    </div>
  );
}
