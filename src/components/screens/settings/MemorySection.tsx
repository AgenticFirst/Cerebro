import { useEffect, useMemo, useState } from 'react';
import { FileText, FolderOpen, Maximize2, Plus, Save, Search, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { useMemory } from '../../../context/MemoryContext';
import { useExperts } from '../../../context/ExpertContext';
import { useMarkdownDocument } from '../../../context/MarkdownDocumentContext';
import { timeAgo } from '../activity/helpers';
import { buildSlugLabelMap, matchesQuery, resolveAgentLabel } from './memory-labels';
import type { AgentMemoryFileContent } from '../../../types/memory';

export default function MemorySection() {
  const { t } = useTranslation();
  const { directories, files, loadDirectories, loadFiles, readFile, writeFile, deleteFile } =
    useMemory();
  const { experts } = useExperts();
  const { open: openMarkdown } = useMarkdownDocument();
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [original, setOriginal] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [agentQuery, setAgentQuery] = useState('');

  // Map each on-disk memory slug to its friendly expert/team name so the list
  // reads as recognizable names instead of hashed slugs (issue #66).
  const slugLabels = useMemo(() => buildSlugLabelMap(experts), [experts]);
  const labelForSlug = useMemo(
    () => (slug: string) => resolveAgentLabel(slug, slugLabels),
    [slugLabels],
  );

  // Filter the agent list by friendly name or raw slug.
  const visibleDirectories = useMemo(
    () => directories.filter((dir) => matchesQuery(labelForSlug(dir.slug), dir.slug, agentQuery)),
    [directories, labelForSlug, agentQuery],
  );

  // Initial directory load
  useEffect(() => {
    loadDirectories();
  }, [loadDirectories]);

  // Auto-select first directory once they load
  useEffect(() => {
    if (!selectedSlug && directories.length > 0) {
      setSelectedSlug(directories[0].slug);
    }
  }, [directories, selectedSlug]);

  // Load files for the selected slug
  useEffect(() => {
    if (selectedSlug) {
      loadFiles(selectedSlug);
    }
  }, [selectedSlug, loadFiles]);

  // Load file content when selection changes
  useEffect(() => {
    let active = true;
    if (selectedSlug && selectedFile) {
      readFile(selectedSlug, selectedFile).then((res: AgentMemoryFileContent | null) => {
        if (!active) return;
        setContent(res?.content ?? '');
        setOriginal(res?.content ?? '');
      });
    } else {
      setContent('');
      setOriginal('');
    }
    return () => {
      active = false;
    };
  }, [selectedSlug, selectedFile, readFile]);

  const slugFiles = useMemo(
    () => (selectedSlug ? (files[selectedSlug] ?? []) : []),
    [files, selectedSlug],
  );

  const isDirty = content !== original;

  const handleSave = async () => {
    if (!selectedSlug || !selectedFile) return;
    await writeFile(selectedSlug, selectedFile, content);
    setOriginal(content);
  };

  const handleDelete = async () => {
    if (!selectedSlug || !selectedFile) return;
    await deleteFile(selectedSlug, selectedFile);
    setSelectedFile(null);
  };

  const handleCreate = async () => {
    if (!selectedSlug || !newPath.trim()) return;
    const safe = newPath.trim().replace(/^\/+/, '');
    const path = safe.endsWith('.md') ? safe : `${safe}.md`;
    await writeFile(selectedSlug, path, '');
    setSelectedFile(path);
    setNewPath('');
    setCreating(false);
  };

  return (
    <div className="flex flex-col gap-6 flex-1 min-h-0">
      <div>
        <h2 className="text-lg font-medium text-text-primary mb-1">{t('memory.title')}</h2>
        <p className="text-sm text-text-secondary">{t('memory.description')}</p>
      </div>

      <div className="flex flex-1 min-h-0 rounded-lg border border-border-subtle bg-bg-surface overflow-hidden">
        {/* Left pane: directories + files */}
        <div className="w-64 flex-shrink-0 border-r border-border-subtle overflow-y-auto scrollbar-thin">
          <div className="p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary mb-2 px-2">
              {t('memory.agents')}
            </div>
            {directories.length > 0 && (
              <div className="relative mb-2 px-2">
                <Search
                  size={12}
                  className="absolute left-4 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none"
                />
                <input
                  type="text"
                  value={agentQuery}
                  onChange={(e) => setAgentQuery(e.target.value)}
                  placeholder={t('memory.searchPlaceholder')}
                  aria-label={t('memory.searchPlaceholder')}
                  className="w-full bg-bg-base border border-border-subtle rounded pl-7 pr-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary/50 focus:outline-none focus:border-accent/40"
                />
              </div>
            )}
            <div className="space-y-px">
              {directories.length === 0 && (
                <div className="text-xs text-text-tertiary px-2 py-3">
                  {t('memory.noAgentsYet')}
                </div>
              )}
              {directories.length > 0 && visibleDirectories.length === 0 && (
                <div className="text-xs text-text-tertiary px-2 py-3">
                  {t('memory.noAgentsMatch')}
                </div>
              )}
              {visibleDirectories.map((dir) => {
                const active = dir.slug === selectedSlug;
                const label = labelForSlug(dir.slug);
                return (
                  <button
                    key={dir.slug}
                    onClick={() => {
                      setSelectedSlug(dir.slug);
                      setSelectedFile(null);
                    }}
                    title={dir.slug}
                    className={clsx(
                      'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors cursor-pointer',
                      active
                        ? 'bg-accent/15 text-text-primary'
                        : 'text-text-secondary hover:text-text-primary hover:bg-white/[0.04]',
                    )}
                  >
                    <FolderOpen
                      size={13}
                      className={active ? 'text-accent' : 'text-text-tertiary'}
                    />
                    <span className="text-xs flex-1 truncate">{label}</span>
                    <span
                      className="text-[10px] text-text-tertiary"
                      title={t('memory.fileCountTooltip', { count: dir.fileCount })}
                    >
                      {dir.fileCount}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {selectedSlug && (
            <div className="border-t border-border-subtle p-3">
              <div className="flex items-center justify-between mb-2 px-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
                  {t('memory.files')}
                </span>
                <button
                  onClick={() => setCreating((v) => !v)}
                  className="text-text-tertiary hover:text-text-primary transition-colors cursor-pointer"
                  title={t('memory.newFile')}
                >
                  <Plus size={12} />
                </button>
              </div>

              {creating && (
                <div className="px-2 mb-2 space-y-2">
                  <input
                    type="text"
                    value={newPath}
                    onChange={(e) => setNewPath(e.target.value)}
                    placeholder={t('memory.newFilePlaceholder')}
                    className="w-full bg-bg-base border border-border-subtle rounded px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary/50 focus:outline-none focus:border-accent/40"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCreate();
                      if (e.key === 'Escape') {
                        setCreating(false);
                        setNewPath('');
                      }
                    }}
                  />
                </div>
              )}

              <div className="space-y-px">
                {slugFiles.length === 0 && !creating && (
                  <div className="text-xs text-text-tertiary px-2 py-2">
                    {t('memory.noFilesYet')}
                  </div>
                )}
                {slugFiles.map((f) => {
                  const active = f.path === selectedFile;
                  return (
                    <button
                      key={f.path}
                      onClick={() => setSelectedFile(f.path)}
                      className={clsx(
                        'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors cursor-pointer',
                        active
                          ? 'bg-accent/15 text-text-primary'
                          : 'text-text-secondary hover:text-text-primary hover:bg-white/[0.04]',
                      )}
                    >
                      <FileText
                        size={12}
                        className={active ? 'text-accent' : 'text-text-tertiary'}
                      />
                      <span className="text-xs flex-1 truncate">{f.path}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Right pane: editor */}
        <div className="flex-1 flex flex-col">
          {selectedSlug && selectedFile ? (
            <>
              <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
                <div className="text-xs text-text-secondary truncate">
                  <span className="text-text-tertiary" title={selectedSlug}>
                    {labelForSlug(selectedSlug)}
                  </span>
                  <span className="text-text-tertiary mx-1">/</span>
                  <span className="text-text-primary font-mono">{selectedFile}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      if (!selectedSlug || !selectedFile) return;
                      openMarkdown({
                        title: selectedFile,
                        subtitle: labelForSlug(selectedSlug),
                        content,
                        initialMode: 'split',
                        onSave: async (md) => {
                          await writeFile(selectedSlug, selectedFile, md);
                          setContent(md);
                          setOriginal(md);
                        },
                      });
                    }}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-text-tertiary hover:text-text-primary hover:bg-white/[0.04] transition-colors cursor-pointer"
                    title={t('markdown.expand')}
                  >
                    <Maximize2 size={11} />
                    {t('markdown.expand')}
                  </button>
                  <button
                    onClick={handleDelete}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-text-tertiary hover:text-red-400 hover:bg-white/[0.04] transition-colors cursor-pointer"
                  >
                    <Trash2 size={11} />
                    {t('common.delete')}
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={!isDirty}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-accent/15 text-accent hover:bg-accent/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <Save size={11} />
                    {t('common.save')}
                  </button>
                </div>
              </div>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={t('memory.editorPlaceholder')}
                className="flex-1 w-full bg-bg-base px-4 py-3 text-sm text-text-secondary font-mono leading-relaxed resize-none focus:outline-none placeholder:text-text-tertiary/50"
              />
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
              <FileText size={28} className="text-text-tertiary/50 mb-3" />
              <div className="text-sm text-text-secondary">
                {selectedSlug ? t('memory.selectFile') : t('memory.selectAgent')}
              </div>
              {directories.length > 0 && selectedSlug && (
                <div className="text-xs text-text-tertiary mt-2">
                  {t('memory.lastUpdated', {
                    time: timeAgo(
                      directories.find((d) => d.slug === selectedSlug)?.lastModified ?? null,
                      t,
                    ),
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
