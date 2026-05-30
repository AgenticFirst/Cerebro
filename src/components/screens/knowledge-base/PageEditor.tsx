// eslint-disable-next-line import/no-unresolved -- CSS exports-map subpath, resolved by Vite
import '@blocknote/core/fonts/inter.css';
// eslint-disable-next-line import/no-unresolved -- CSS exports-map subpath, resolved by Vite
import '@blocknote/mantine/style.css';
import './knowledge-base.css';

import { useEffect, useRef } from 'react';
import type { Block } from '@blocknote/core';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { BookOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../../context/ThemeContext';
import { useKnowledgeBase, type KbPage } from '../../../context/KnowledgeBaseContext';
import { kbTheme } from './blocknote-theme';
import { PageHeader } from './PageHeader';
import { CoverBanner } from './CoverBanner';

const AUTOSAVE_MS = 600;

/**
 * The actual BlockNote surface for one page. Mounted with a `key={page.id}` by
 * the parent so each page gets a fresh editor seeded with its own content;
 * edits are debounced and persisted as both BlockNote JSON and a markdown
 * mirror (for the agent). Pending edits flush on unmount (page switch).
 */
function BlockEditor({ page }: { page: KbPage }) {
  const { resolvedTheme } = useTheme();
  const { savePageContent } = useKnowledgeBase();

  let initialContent: Block[] | undefined;
  if (page.contentJson) {
    try {
      const parsed = JSON.parse(page.contentJson);
      if (Array.isArray(parsed) && parsed.length > 0) initialContent = parsed as Block[];
    } catch {
      initialContent = undefined;
    }
  }

  const editor = useCreateBlockNote({ initialContent });

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(false);

  // Agent-written pages arrive as markdown (content_markdown) with no BlockNote
  // JSON yet. Convert markdown → blocks on open and persist the JSON so it
  // becomes the canonical representation from then on.
  useEffect(() => {
    const markdown = page.contentMarkdown;
    if (initialContent || !markdown) return;
    let cancelled = false;
    void (async () => {
      const blocks = await editor.tryParseMarkdownToBlocks(markdown);
      if (cancelled || blocks.length === 0) return;
      editor.replaceBlocks(editor.document, blocks);
      const json = JSON.stringify(editor.document);
      await savePageContent(page.id, json, markdown);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = async () => {
    pending.current = false;
    const json = JSON.stringify(editor.document);
    const markdown = await editor.blocksToMarkdownLossy(editor.document);
    await savePageContent(page.id, json, markdown);
  };

  const handleChange = () => {
    pending.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void persist();
    }, AUTOSAVE_MS);
  };

  // Flush any pending edit when the page unmounts (switch / navigate away).
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (pending.current) void persist();
    };
  }, []);

  return (
    <BlockNoteView editor={editor} theme={kbTheme(resolvedTheme)} onChange={handleChange} />
  );
}

/**
 * Knowledge Base page pane: empty state when nothing is selected, otherwise the
 * page header (icon + title) and the block editor.
 */
export default function PageEditor() {
  const { t } = useTranslation();
  const { activePage } = useKnowledgeBase();

  if (!activePage) {
    return (
      <div className="kb-editor-container flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-center px-6">
          <BookOpen size={28} className="text-text-tertiary" strokeWidth={1.5} />
          <p className="text-[15px] font-medium text-text-secondary">
            {t('knowledgeBase.emptyStateTitle')}
          </p>
          <p className="text-[13px] text-text-tertiary max-w-xs leading-relaxed">
            {t('knowledgeBase.emptyStateSubtitle')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="kb-editor-container">
      <CoverBanner page={activePage} />
      <div className={activePage.coverUrl ? 'kb-page-column pt-4' : 'kb-page-column pt-10'}>
        <PageHeader page={activePage} />
        {/* Key includes a content signature so an external reload (e.g. the AI
            assistant edited this page) remounts the editor with fresh content.
            Normal in-editor edits don't change activePage in context, so the
            key stays stable and typing is never interrupted. */}
        <BlockEditor
          key={`${activePage.id}:${activePage.contentJson?.length ?? 0}`}
          page={activePage}
        />
      </div>
    </div>
  );
}
