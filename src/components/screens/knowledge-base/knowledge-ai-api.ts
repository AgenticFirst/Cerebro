import type { BackendResponse } from '../../../types/ipc';

/* ── Types ─────────────────────────────────────────────────────── */

export interface KbAiThread {
  id: string;
  pageId: string;
  title: string;
  updatedAt: string;
}

export interface KbAiMessage {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
}

interface ApiThread {
  id: string;
  page_id: string;
  title: string;
  updated_at: string;
}
interface ApiMessage {
  id: string;
  thread_id: string;
  role: string;
  content: string;
}

const toThread = (t: ApiThread): KbAiThread => ({
  id: t.id,
  pageId: t.page_id,
  title: t.title,
  updatedAt: t.updated_at,
});
const toMessage = (m: ApiMessage): KbAiMessage => ({
  id: m.id,
  threadId: m.thread_id,
  role: m.role === 'assistant' ? 'assistant' : 'user',
  content: m.content,
});

/* ── CRUD (wraps window.cerebro.invoke against /knowledge/ai) ────── */

export async function listThreads(pageId: string): Promise<KbAiThread[]> {
  try {
    const res: BackendResponse<{ threads: ApiThread[] }> = await window.cerebro.invoke({
      method: 'GET',
      path: `/knowledge/ai/threads?page_id=${encodeURIComponent(pageId)}`,
    });
    if (res.ok) return res.data.threads.map(toThread);
  } catch {
    /* ignore */
  }
  return [];
}

export async function createThread(pageId: string, title = 'New chat'): Promise<KbAiThread | null> {
  try {
    const res: BackendResponse<ApiThread> = await window.cerebro.invoke({
      method: 'POST',
      path: '/knowledge/ai/threads',
      body: { page_id: pageId, title },
    });
    if (res.ok) return toThread(res.data);
  } catch {
    /* ignore */
  }
  return null;
}

export async function renameThread(threadId: string, title: string): Promise<void> {
  try {
    await window.cerebro.invoke({
      method: 'PATCH',
      path: `/knowledge/ai/threads/${threadId}`,
      body: { title },
    });
  } catch {
    /* ignore */
  }
}

export async function deleteThread(threadId: string): Promise<void> {
  try {
    await window.cerebro.invoke({ method: 'DELETE', path: `/knowledge/ai/threads/${threadId}` });
  } catch {
    /* ignore */
  }
}

export async function listMessages(threadId: string): Promise<KbAiMessage[]> {
  try {
    const res: BackendResponse<{ messages: ApiMessage[] }> = await window.cerebro.invoke({
      method: 'GET',
      path: `/knowledge/ai/threads/${threadId}/messages`,
    });
    if (res.ok) return res.data.messages.map(toMessage);
  } catch {
    /* ignore */
  }
  return [];
}

export async function appendMessage(
  threadId: string,
  role: 'user' | 'assistant',
  content: string,
): Promise<void> {
  try {
    await window.cerebro.invoke({
      method: 'POST',
      path: `/knowledge/ai/threads/${threadId}/messages`,
      body: { role, content },
    });
  } catch {
    /* ignore */
  }
}

/** Fetch the freshest persisted title + markdown for a page (the in-editor
 *  autosave writes to the DB but not to the KB context, so the context copy can
 *  lag the user's latest keystrokes). Falls back to the caller's values. */
export async function fetchPageContent(
  pageId: string,
  fallbackTitle: string,
  fallbackMarkdown: string,
): Promise<{ title: string; markdown: string }> {
  try {
    const res: BackendResponse<{ title: string; content_markdown: string | null }> =
      await window.cerebro.invoke({ method: 'GET', path: `/knowledge/pages/${pageId}` });
    if (res.ok) {
      return { title: res.data.title ?? fallbackTitle, markdown: res.data.content_markdown ?? '' };
    }
  } catch {
    /* ignore */
  }
  return { title: fallbackTitle, markdown: fallbackMarkdown };
}

/* ── Prompt building ───────────────────────────────────────────── */

/**
 * Build the one-off prompt for the assistant run: scope it to the page, hand it
 * the page content + prior turns, and let it use web search when useful.
 */
export function buildAskPrompt(
  pageTitle: string,
  pageMarkdown: string,
  history: KbAiMessage[],
  question: string,
): string {
  const lines: string[] = [
    'You are answering questions about a single Knowledge Base page. Use the page',
    'content below as your primary source. If the question needs current or',
    'external information not in the page, use your WebSearch / WebFetch tools.',
    'Be concise and directly helpful. Do not create tasks, experts, or routines.',
    '',
    `# Page: ${pageTitle?.trim() || 'Untitled'}`,
    '',
    (pageMarkdown || '').trim() || '(this page is empty)',
  ];
  if (history.length > 0) {
    lines.push('', '# Conversation so far');
    for (const m of history) {
      lines.push('', `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`);
    }
  }
  lines.push('', '# New question', '', question.trim());
  return lines.join('\n');
}

/** Auto-title a new thread from its first question (trimmed to ~60 chars). */
export function deriveThreadTitle(question: string): string {
  const q = question.trim().replace(/\s+/g, ' ');
  return q.length > 60 ? `${q.slice(0, 57)}…` : q || 'New chat';
}
