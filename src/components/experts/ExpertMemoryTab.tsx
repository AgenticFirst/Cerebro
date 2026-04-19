/**
 * Expert-scoped memory viewer/editor.
 * Shows the expert's agent-memory directory files in an accordion layout.
 * SOUL.md (identity file) always appears first.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ChevronDown, FileText, Maximize2, Plus, RefreshCw, Save, Sparkles, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import type { Expert } from '../../context/ExpertContext';
import { useMemory } from '../../context/MemoryContext';
import { useMarkdownDocument } from '../../context/MarkdownDocumentContext';
import { useTranslation } from 'react-i18next';

interface ExpertMemoryTabProps {
  expert: Expert;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export default function ExpertMemoryTab({ expert }: ExpertMemoryTabProps) {
  const slug = expert.slug;
  const { files, loadFiles, readFile, writeFile, deleteFile } = useMemory();
  const { open: openMarkdown } = useMarkdownDocument();
  const { t } = useTranslation();

  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const requestRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load file listing when slug changes
  useEffect(() => {
    if (slug) loadFiles(slug);
  }, [slug, loadFiles]);

  // Reset expanded file when expert changes
  useEffect(() => {
    setExpandedFile(null);
    setEditContent('');
    setOriginalContent('');
    setCreating(false);
    setConfirmDelete(false);
  }, [expert.id]);

  const sortedFiles = useMemo(() => {
    const list = slug ? files[slug] ?? [] : [];
    return [...list].sort((a, b) => {
      if (a.path === 'SOUL.md') return -1;
      if (b.path === 'SOUL.md') return 1;
      return a.path.localeCompare(b.path);
    });
  }, [files, slug]);

  const isDirty = editContent !== originalContent;

  const handleRefresh = useCallback(async () => {
    if (!slug) return;
    setIsRefreshing(true);
    await loadFiles(slug);
    setIsRefreshing(false);
  }, [slug, loadFiles]);

  const handleExpand = useCallback(
    async (path: string) => {
      if (!slug) return;

      // Collapse if already expanded
      if (expandedFile === path) {
        setExpandedFile(null);
        setConfirmDelete(false);
        return;
      }

      // Expand new file
      setExpandedFile(path);
      setIsLoadingContent(true);
      setConfirmDelete(false);
      const id = ++requestRef.current;

      const result = await readFile(slug, path);
      // Ignore stale responses
      if (id !== requestRef.current) return;

      setEditContent(result?.content ?? '');
      setOriginalContent(result?.content ?? '');
      setIsLoadingContent(false);

      // Auto-focus textarea
      setTimeout(() => textareaRef.current?.focus(), 50);
    },
    [slug, expandedFile, readFile],
  );

  const handleSave = useCallback(async () => {
    if (!slug || !expandedFile) return;
    await writeFile(slug, expandedFile, editContent);
    setOriginalContent(editContent);
  }, [slug, expandedFile, editContent, writeFile]);

  const handleDelete = useCallback(async () => {
    if (!slug || !expandedFile) return;
    await deleteFile(slug, expandedFile);
    setExpandedFile(null);
    setConfirmDelete(false);
  }, [slug, expandedFile, deleteFile]);

  const createFile = useCallback(
    async (path: string) => {
      if (!slug) return;
      await writeFile(slug, path, '');
      setExpandedFile(path);
      setEditContent('');
      setOriginalContent('');
      setTimeout(() => textareaRef.current?.focus(), 50);
    },
    [slug, writeFile],
  );

  const handleCreate = useCallback(async () => {
    if (!newPath.trim()) return;
    const safe = newPath.trim().replace(/^\/+/, '');
    const path = safe.endsWith('.md') ? safe : `${safe}.md`;
    await createFile(path);
    setNewPath('');
    setCreating(false);
  }, [newPath, createFile]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (isDirty) handleSave();
      }
    },
    [isDirty, handleSave],
  );

  // No slug — expert hasn't run yet
  if (!slug) {
    return (
      <p className="text-xs text-text-tertiary leading-relaxed">
        Memory will be created when this expert first runs.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
          {sortedFiles.length} file{sortedFiles.length !== 1 ? 's' : ''}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              setCreating((v) => !v);
              setNewPath('');
            }}
            className="p-1 text-text-tertiary hover:text-text-secondary transition-colors"
            title="New file"
          >
            <Plus size={12} />
          </button>
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="p-1 text-text-tertiary hover:text-text-secondary transition-colors"
            title="Refresh"
          >
            <RefreshCw size={12} className={isRefreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Create new file input */}
      {creating && (
        <input
          type="text"
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
          placeholder="filename.md"
          autoFocus
          className="w-full bg-bg-base border border-border-subtle rounded px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary/50 focus:outline-none focus:border-accent/40"
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleCreate();
            if (e.key === 'Escape') {
              setCreating(false);
              setNewPath('');
            }
          }}
        />
      )}

      {sortedFiles.length === 0 ? (
        <div className="text-center py-4">
          <p className="text-xs text-text-tertiary mb-2">No memory files yet.</p>
          <button
            onClick={() => createFile('SOUL.md')}
            className="text-xs text-accent hover:text-accent-hover transition-colors"
          >
            Create SOUL.md
          </button>
        </div>
      ) : (
        <div className="space-y-1">
          {sortedFiles.map((file) => {
            const isExpanded = expandedFile === file.path;
            const isSoul = file.path === 'SOUL.md';
            const Icon = isSoul ? Sparkles : FileText;

            return (
              <div
                key={file.path}
                className="rounded-lg border border-border-subtle overflow-hidden"
              >
                <div
                  className={clsx(
                    'w-full flex items-center transition-colors',
                    isExpanded ? 'bg-bg-base' : 'bg-bg-surface hover:bg-bg-base',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => handleExpand(file.path)}
                    className="flex-1 min-w-0 flex items-center gap-2 px-2.5 py-2 text-left cursor-pointer"
                  >
                    <Icon
                      size={12}
                      className={isSoul ? 'text-accent' : 'text-text-tertiary'}
                    />
                    <span className="text-xs text-text-primary flex-1 truncate font-mono">
                      {file.path}
                    </span>
                    {isExpanded && isDirty && (
                      <div className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
                    )}
                    <span className="text-[10px] text-text-tertiary flex-shrink-0">
                      {formatSize(file.size)}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      // Read fresh from disk so we don't show the buffered copy
                      // of a different file the user previously expanded.
                      readFile(slug, file.path).then((res) => {
                        openMarkdown({
                          title: file.path,
                          subtitle: slug,
                          content: res?.content ?? '',
                          initialMode: 'split',
                          onSave: async (md) => {
                            await writeFile(slug, file.path, md);
                            if (expandedFile === file.path) {
                              setEditContent(md);
                              setOriginalContent(md);
                            }
                          },
                        });
                      });
                    }}
                    className="p-2 text-text-tertiary hover:text-text-primary transition-colors flex-shrink-0"
                    title={t('markdown.expand')}
                  >
                    <Maximize2 size={11} />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleExpand(file.path)}
                    className="p-2 text-text-tertiary hover:text-text-primary transition-colors flex-shrink-0"
                    aria-label={isExpanded ? 'Collapse' : 'Expand inline'}
                  >
                    <ChevronDown
                      size={12}
                      className={clsx(
                        'transition-transform duration-150',
                        isExpanded ? 'rotate-0' : '-rotate-90',
                      )}
                    />
                  </button>
                </div>

                {isExpanded && (
                  <div className="border-t border-border-subtle">
                    {isLoadingContent ? (
                      <div className="flex items-center justify-center py-6">
                        <RefreshCw size={14} className="text-text-tertiary animate-spin" />
                      </div>
                    ) : (
                      <>
                        <textarea
                          ref={textareaRef}
                          value={editContent}
                          onChange={(e) => setEditContent(e.target.value)}
                          onKeyDown={handleKeyDown}
                          placeholder="Write markdown the agent reads every turn..."
                          className="w-full bg-bg-base px-3 py-2 text-xs text-text-secondary font-mono leading-relaxed resize-none focus:outline-none placeholder:text-text-tertiary/50 h-[200px] overflow-y-auto scrollbar-thin"
                        />
                        <div className="flex items-center justify-between px-2.5 py-1.5 border-t border-border-subtle bg-bg-surface">
                          {confirmDelete ? (
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] text-red-400">Delete this file?</span>
                              <button
                                onClick={handleDelete}
                                className="text-[10px] text-red-400 hover:text-red-300 font-medium transition-colors"
                              >
                                Yes
                              </button>
                              <button
                                onClick={() => setConfirmDelete(false)}
                                className="text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
                              >
                                No
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setConfirmDelete(true)}
                              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-text-tertiary hover:text-red-400 transition-colors"
                            >
                              <Trash2 size={10} />
                              Delete
                            </button>
                          )}
                          <button
                            onClick={handleSave}
                            disabled={!isDirty}
                            className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-accent/15 text-accent hover:bg-accent/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <Save size={10} />
                            Save
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
