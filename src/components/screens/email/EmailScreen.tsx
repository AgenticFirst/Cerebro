/**
 * Email screen — Superhuman-style triage over the local Gmail mirror.
 *
 * Three zones: split tabs (AI labels + system views) → thread list → thread
 * reader. Search is instant against the local FTS index with live-Gmail
 * fall-through. Keyboard: j/k move, e archive, r reply, c compose, / search.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CornerUpLeft,
  Inbox,
  Loader2,
  Mail,
  Paperclip,
  PenLine,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { useChat } from '../../../context/ChatContext';
import type { GmailMessageSummary, GmailStatus } from '../../../gmail/types';
import { fetchThreads, formatWhen, senderName, type EmailTab, type EmailThread } from './email-api';
import ThreadView from './ThreadView';
import ComposeView, { type ComposeSeed } from './ComposeView';

const TABS: Array<{ id: EmailTab; labelKey: string }> = [
  { id: 'inbox', labelKey: 'gmail.screen.tabs.inbox' },
  { id: 'important', labelKey: 'gmail.screen.tabs.important' },
  { id: 'awaiting_reply', labelKey: 'gmail.screen.tabs.awaitingReply' },
  { id: 'team', labelKey: 'gmail.screen.tabs.team' },
  { id: 'marketing', labelKey: 'gmail.screen.tabs.marketing' },
  { id: 'notifications', labelKey: 'gmail.screen.tabs.notifications' },
  { id: 'snoozed', labelKey: 'gmail.screen.tabs.snoozed' },
];

function isEditableTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return Boolean(
    el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable),
  );
}

export default function EmailScreen() {
  const { t, i18n } = useTranslation();
  const { setActiveScreen } = useChat();
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [tab, setTab] = useState<EmailTab>('inbox');
  const [threads, setThreads] = useState<EmailThread[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compose, setCompose] = useState<ComposeSeed | null>(null);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<GmailMessageSummary[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchSeq = useRef(0);

  const refreshStatus = useCallback(async () => {
    setStatus(await window.cerebro.gmail.status());
  }, []);

  const loadThreads = useCallback(async () => {
    const { threads: rows } = await fetchThreads(tab);
    setThreads(rows);
  }, [tab]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    setThreads(null);
    setSelectedId(null);
    void loadThreads();
  }, [loadThreads]);

  // Live refresh when the bridge syncs.
  useEffect(() => {
    const off = window.cerebro.gmail.onChanged(() => {
      void loadThreads();
      void refreshStatus();
    });
    return off;
  }, [loadThreads, refreshStatus]);

  // Debounced instant search.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const seq = ++searchSeq.current;
    const id = setTimeout(async () => {
      const res = await window.cerebro.gmail.search(q, { maxResults: 40 });
      if (searchSeq.current !== seq) return;
      setSearchResults(res.ok ? (res.messages ?? []) : []);
      setSearching(false);
    }, 250);
    return () => clearTimeout(id);
  }, [query]);

  const selected = useMemo(
    () => threads?.find((th) => th.id === selectedId) ?? null,
    [threads, selectedId],
  );

  const syncNow = async () => {
    setRefreshing(true);
    await window.cerebro.gmail.syncNow();
    await loadThreads();
    setRefreshing(false);
  };

  const openSearchHit = (msg: GmailMessageSummary) => {
    // Search hits may be outside the current tab — synthesize a transient
    // thread row so ThreadView can load it.
    setQuery('');
    setSearchResults(null);
    setTab('all');
    setSelectedId(null);
    void fetchThreads('all').then(({ threads: rows }) => {
      setThreads(rows);
      const hit = rows.find((r) => r.thread_id === msg.threadId);
      setSelectedId(hit ? hit.id : null);
    });
  };

  // Keyboard triage.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e) || compose || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!threads) return;
      const idx = threads.findIndex((th) => th.id === selectedId);
      if (e.key === 'j') {
        setSelectedId(threads[Math.min(idx + 1, threads.length - 1)]?.id ?? null);
      } else if (e.key === 'k') {
        setSelectedId(threads[Math.max(idx - 1, 0)]?.id ?? null);
      } else if (e.key === 'c') {
        e.preventDefault();
        setCompose({});
      } else if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [threads, selectedId, compose]);

  // ── Not-connected state ────────────────────────────────────────────────────
  if (status && !status.connected) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
        <div className="w-12 h-12 rounded-2xl bg-red-500/15 text-red-400 flex items-center justify-center">
          <Mail size={22} />
        </div>
        <h2 className="text-[16px] font-semibold text-text-primary">
          {t('gmail.screen.notConnectedTitle')}
        </h2>
        <p className="text-[13px] text-text-secondary max-w-sm">
          {t('gmail.screen.notConnectedBody')}
        </p>
        <button
          onClick={() => setActiveScreen('integrations')}
          className="mt-1 px-3.5 py-1.5 rounded-md text-[12px] font-medium bg-accent text-black hover:brightness-110 cursor-pointer"
        >
          {t('gmail.section.connect')}
        </button>
      </div>
    );
  }

  const showSearch = query.trim().length > 0;

  return (
    <div className="flex-1 min-h-0 flex flex-col relative">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 pt-1 pb-2">
        <h1 className="text-[16px] font-semibold text-text-primary">{t('gmail.screen.title')}</h1>
        <div className="relative flex-1 max-w-md">
          <Search
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
          />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            placeholder={t('gmail.screen.searchPlaceholder')}
            className="w-full bg-bg-surface border border-border-subtle rounded-md pl-8 pr-8 py-1.5 text-[12px] text-text-primary outline-none focus:border-accent placeholder:text-text-tertiary"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary cursor-pointer"
            >
              <X size={12} />
            </button>
          )}
        </div>
        <span className="ml-auto text-[11px] text-text-tertiary">
          {status?.accounts[0]?.email ?? ''}
        </span>
        <button
          onClick={() => void syncNow()}
          disabled={refreshing}
          title={t('gmail.screen.refresh')}
          className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover disabled:opacity-50 cursor-pointer"
        >
          <RefreshCw size={13} className={clsx(refreshing && 'animate-spin')} />
        </button>
        <button
          onClick={() => setCompose({})}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium bg-accent text-black hover:brightness-110 cursor-pointer"
        >
          <PenLine size={12} /> {t('gmail.screen.composeButton')}
        </button>
      </div>

      {/* Tabs */}
      {!showSearch && (
        <div className="flex items-center gap-1 px-4 pb-2 overflow-x-auto">
          {TABS.map(({ id, labelKey }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={clsx(
                'px-2.5 py-1 rounded-md text-[12px] whitespace-nowrap cursor-pointer',
                tab === id
                  ? 'bg-accent/15 text-accent font-medium'
                  : 'text-text-secondary hover:bg-bg-hover',
              )}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 min-h-0 flex border-t border-border-subtle">
        {/* Search results OR thread list */}
        <div className="w-[380px] shrink-0 border-r border-border-subtle overflow-y-auto">
          {showSearch ? (
            <>
              {searching && (
                <div className="flex items-center gap-2 px-4 py-3 text-[12px] text-text-tertiary">
                  <Loader2 size={12} className="animate-spin" /> {t('gmail.screen.searching')}
                </div>
              )}
              {searchResults?.map((m) => (
                <button
                  key={m.id}
                  onClick={() => openSearchHit(m)}
                  className="w-full text-left px-4 py-2.5 border-b border-border-subtle/50 hover:bg-bg-hover cursor-pointer"
                >
                  <span className="flex items-baseline gap-2">
                    <span className="flex-1 min-w-0 text-[12px] font-medium text-text-primary truncate">
                      {senderName(m.from)}
                    </span>
                    <span className="text-[10px] text-text-tertiary shrink-0">
                      {formatWhen(m.receivedAt, i18n.language)}
                    </span>
                  </span>
                  <span className="block text-[12px] text-text-secondary truncate">
                    {m.subject}
                  </span>
                  <span className="block text-[11px] text-text-tertiary truncate">{m.snippet}</span>
                </button>
              ))}
              {searchResults !== null && searchResults.length === 0 && !searching && (
                <p className="px-4 py-6 text-[12px] text-text-tertiary text-center">
                  {t('gmail.screen.noResults')}
                </p>
              )}
            </>
          ) : (
            <>
              {threads === null && (
                <div className="flex items-center justify-center py-10 text-text-tertiary">
                  <Loader2 size={16} className="animate-spin" />
                </div>
              )}
              {threads?.map((th) => (
                <button
                  key={th.id}
                  onClick={() => setSelectedId(th.id)}
                  className={clsx(
                    'w-full text-left px-4 py-2.5 border-b border-border-subtle/50 cursor-pointer',
                    selectedId === th.id ? 'bg-accent/[0.07]' : 'hover:bg-bg-hover',
                  )}
                >
                  <span className="flex items-center gap-2">
                    {th.unread_count > 0 && (
                      <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                    )}
                    <span
                      className={clsx(
                        'flex-1 min-w-0 text-[12px] truncate',
                        th.unread_count > 0
                          ? 'font-semibold text-text-primary'
                          : 'text-text-secondary',
                      )}
                    >
                      {th.subject || t('gmail.screen.noSubject')}
                    </span>
                    {th.awaiting_reply && (
                      <CornerUpLeft size={10} className="text-amber-400 shrink-0" />
                    )}
                    {th.has_attachments && (
                      <Paperclip size={10} className="text-text-tertiary shrink-0" />
                    )}
                    <span className="text-[10px] text-text-tertiary shrink-0">
                      {formatWhen(th.last_message_at, i18n.language)}
                    </span>
                  </span>
                  <span className="block text-[11px] text-text-tertiary truncate mt-0.5">
                    {th.ai_summary ? (
                      <span className="inline-flex items-center gap-1">
                        <Sparkles size={9} className="text-accent/70 shrink-0" />
                        {th.ai_summary}
                      </span>
                    ) : (
                      th.snippet
                    )}
                  </span>
                </button>
              ))}
              {threads !== null && threads.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-10 text-text-tertiary">
                  <Inbox size={18} />
                  <p className="text-[12px]">{t('gmail.screen.emptyTab')}</p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Reader */}
        {selected ? (
          <ThreadView
            thread={selected}
            onArchived={() => {
              setSelectedId(null);
              void loadThreads();
            }}
            onSnoozed={() => {
              setSelectedId(null);
              void loadThreads();
            }}
            onReply={(seed) => setCompose(seed)}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-text-tertiary">
            <p className="text-[12px]">{t('gmail.screen.selectThread')}</p>
          </div>
        )}
      </div>

      {compose && (
        <ComposeView
          seed={compose}
          onClose={() => setCompose(null)}
          onSent={() => void loadThreads()}
        />
      )}
    </div>
  );
}
