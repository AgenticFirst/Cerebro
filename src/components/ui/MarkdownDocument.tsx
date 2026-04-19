/**
 * MarkdownDocument — full-screen overlay for reading and editing markdown.
 * Three modes (view / edit / split) share one shell so toggling never reflows.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Bold,
  Code,
  Eye,
  FolderOpen,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Pencil,
  Quote,
  SplitSquareVertical,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import MarkdownContent from '../chat/MarkdownContent';
import AlertModal from './AlertModal';
import { useToast } from '../../context/ToastContext';

export type MarkdownDocumentMode = 'view' | 'edit' | 'split';

export interface MarkdownDocumentProps {
  /** Title shown in the header (e.g. filename). Defaults to the i18n "Untitled". */
  title?: string;
  /** Secondary line under the title — typically a breadcrumb or file path. */
  subtitle?: string;
  /** Current markdown content. Treated as the initial draft on open. */
  content: string;
  /** Called when the user saves (⌘S or Save button). Omit for read-only. */
  onSave?: (md: string) => void | Promise<void>;
  /** Called when the user dismisses the overlay (X, Esc, or backdrop). */
  onClose: () => void;
  /** Mode the overlay opens in. Defaults to `split` when editable, `view` when read-only. */
  initialMode?: MarkdownDocumentMode;
  /** Force read-only regardless of `onSave`. */
  readOnly?: boolean;
  /** When set, footer shows a Reveal-in-Finder action. */
  filePath?: string;
}

interface SelectionEdit {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

function wrapSelection(
  value: string,
  start: number,
  end: number,
  before: string,
  after: string,
  placeholder: string,
): SelectionEdit {
  const selected = value.slice(start, end) || placeholder;
  const next = value.slice(0, start) + before + selected + after + value.slice(end);
  const newStart = start + before.length;
  const newEnd = newStart + selected.length;
  return { value: next, selectionStart: newStart, selectionEnd: newEnd };
}

/** Prefix every line that overlaps the selection with `prefix`. */
function prefixLines(
  value: string,
  start: number,
  end: number,
  prefix: string,
): SelectionEdit {
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const lineEndIdx = value.indexOf('\n', end);
  const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
  const block = value.slice(lineStart, lineEnd);
  const transformed = block
    .split('\n')
    .map((line) => (line.length > 0 || prefix.endsWith(' ') ? prefix + line : line))
    .join('\n');
  const next = value.slice(0, lineStart) + transformed + value.slice(lineEnd);
  const delta = transformed.length - block.length;
  return {
    value: next,
    selectionStart: start + prefix.length,
    selectionEnd: end + delta,
  };
}

/** Insert a horizontal rule on its own line. */
function insertHr(value: string, start: number, end: number): SelectionEdit {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const needsLeadingNewline = before.length > 0 && !before.endsWith('\n');
  const needsTrailingNewline = after.length > 0 && !after.startsWith('\n');
  const insert =
    (needsLeadingNewline ? '\n' : '') + '---' + (needsTrailingNewline ? '\n' : '');
  const next = before + insert + after;
  const cursor = start + insert.length;
  return { value: next, selectionStart: cursor, selectionEnd: cursor };
}

/** Continue list markers when Enter is pressed inside a list item. */
function continueListOnEnter(value: string, caret: number): SelectionEdit | null {
  const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
  const currentLine = value.slice(lineStart, caret);
  const m = /^(\s*)([-*+]\s|\d+\.\s|-\s\[\s\]\s|-\s\[x\]\s)(.*)$/.exec(currentLine);
  if (!m) return null;
  const [, indent, marker, rest] = m;
  // Empty item with marker → exit the list (clear the marker line).
  if (rest.length === 0) {
    const next = value.slice(0, lineStart) + value.slice(caret);
    return { value: next, selectionStart: lineStart, selectionEnd: lineStart };
  }
  // Increment numbered list markers.
  const numbered = /^(\d+)\.\s$/.exec(marker);
  const nextMarker = numbered ? `${Number(numbered[1]) + 1}. ` : marker;
  const insert = '\n' + indent + nextMarker;
  const next = value.slice(0, caret) + insert + value.slice(caret);
  const cursor = caret + insert.length;
  return { value: next, selectionStart: cursor, selectionEnd: cursor };
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

interface ToolbarButtonProps {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  shortcut?: string;
}

function ToolbarButton({ icon, label, onClick, shortcut }: ToolbarButtonProps) {
  const title = shortcut ? `${label}  (${shortcut})` : label;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={label}
      className="w-8 h-8 flex items-center justify-center rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
    >
      {icon}
    </button>
  );
}

export default function MarkdownDocument({
  title,
  subtitle,
  content,
  onSave,
  onClose,
  initialMode,
  readOnly = false,
  filePath,
}: MarkdownDocumentProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const editable = !readOnly && !!onSave;

  const [mode, setMode] = useState<MarkdownDocumentMode>(
    initialMode ?? (editable ? 'split' : 'view'),
  );
  const [draft, setDraft] = useState(content);
  const [savedSnapshot, setSavedSnapshot] = useState(content);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isDirty = editable && draft !== savedSnapshot;

  // If the parent updates `content` while the doc is open without the user
  // having edited anything, sync the draft. (Once dirty, we don't clobber.)
  useEffect(() => {
    if (content === savedSnapshot) return;
    setDraft((prev) => (prev === savedSnapshot ? content : prev));
    setSavedSnapshot(content);
  }, [content, savedSnapshot]);

  const handleSave = useCallback(async () => {
    if (!editable || !onSave || !isDirty || isSaving) return;
    setIsSaving(true);
    try {
      await onSave(draft);
      setSavedSnapshot(draft);
      addToast(t('markdown.saved'), 'success');
    } catch {
      addToast(t('markdown.loadFailed'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [editable, onSave, isDirty, isSaving, draft, addToast, t]);

  const requestClose = useCallback(() => {
    if (isDirty) {
      setConfirmingClose(true);
    } else {
      onClose();
    }
  }, [isDirty, onClose]);

  const cycleMode = useCallback(() => {
    if (!editable) return;
    setMode((m) => (m === 'view' ? 'edit' : m === 'edit' ? 'split' : 'view'));
  }, [editable]);

  const applyEdit = useCallback((edit: SelectionEdit) => {
    setDraft(edit.value);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(edit.selectionStart, edit.selectionEnd);
    });
  }, []);

  const withSelection = useCallback(
    (fn: (start: number, end: number) => SelectionEdit) => {
      const ta = textareaRef.current;
      if (!ta) return;
      applyEdit(fn(ta.selectionStart, ta.selectionEnd));
    },
    [applyEdit],
  );

  const toggleBold = () =>
    withSelection((s, e) => wrapSelection(draft, s, e, '**', '**', 'bold text'));
  const toggleItalic = () =>
    withSelection((s, e) => wrapSelection(draft, s, e, '_', '_', 'italic text'));
  const toggleCode = () =>
    withSelection((s, e) => wrapSelection(draft, s, e, '`', '`', 'code'));
  const insertLink = () =>
    withSelection((s, e) => wrapSelection(draft, s, e, '[', '](https://)', 'link text'));
  const headingPrefix = (level: 1 | 2 | 3) => () =>
    withSelection((s, e) => prefixLines(draft, s, e, '#'.repeat(level) + ' '));
  const blockquote = () => withSelection((s, e) => prefixLines(draft, s, e, '> '));
  const bulletList = () => withSelection((s, e) => prefixLines(draft, s, e, '- '));
  const numberList = () => withSelection((s, e) => prefixLines(draft, s, e, '1. '));
  const checklist = () => withSelection((s, e) => prefixLines(draft, s, e, '- [ ] '));
  const horizontalRule = () => withSelection((s, e) => insertHr(draft, s, e));

  // Window-level so shortcuts work from any pane (preview included).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta && e.key === 'Escape') {
        e.preventDefault();
        requestClose();
        return;
      }
      if (meta && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void handleSave();
        return;
      }
      if (meta && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        cycleMode();
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [requestClose, handleSave, cycleMode]);

  const handleEditorKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleBold();
        return;
      }
      if (meta && !e.shiftKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        toggleItalic();
        return;
      }
      if (meta && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        insertLink();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const ta = e.currentTarget;
        const s = ta.selectionStart;
        const eIdx = ta.selectionEnd;
        applyEdit({
          value: draft.slice(0, s) + '  ' + draft.slice(eIdx),
          selectionStart: s + 2,
          selectionEnd: s + 2,
        });
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        const ta = e.currentTarget;
        if (ta.selectionStart !== ta.selectionEnd) return;
        const next = continueListOnEnter(draft, ta.selectionStart);
        if (next) {
          e.preventDefault();
          applyEdit(next);
        }
      }
    },
    [draft, applyEdit, toggleBold, toggleItalic, insertLink],
  );

  const wordCount = useMemo(() => countWords(draft), [draft]);
  const previewBody = mode === 'view' ? content : draft;

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-stretch justify-center">
        {/* Backdrop */}
        <div
          className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in"
          onClick={requestClose}
        />

        {/* Panel */}
        <div
          className={clsx(
            'relative m-4 sm:m-8 w-full max-w-[1320px] flex flex-col',
            'bg-bg-surface border border-border-subtle rounded-2xl shadow-2xl',
            'overflow-hidden animate-md-doc-panel',
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex-shrink-0 flex items-center gap-3 px-5 py-3 border-b border-border-subtle">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 min-w-0">
                <h2 className="text-sm font-medium text-text-primary truncate">
                  {title || t('markdown.untitled')}
                </h2>
                {isDirty && (
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0"
                    title={t('markdown.unsaved')}
                  />
                )}
              </div>
              {subtitle && (
                <div className="text-[11px] text-text-tertiary font-mono truncate mt-0.5">
                  {subtitle}
                </div>
              )}
            </div>

            {/* Mode toggle (hidden when read-only — there's only one mode) */}
            {editable && (
              <div className="flex items-center bg-bg-elevated rounded-md p-0.5 border border-border-subtle">
                {(['view', 'edit', 'split'] as const).map((m) => {
                  const active = mode === m;
                  const Icon = m === 'view' ? Eye : m === 'edit' ? Pencil : SplitSquareVertical;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMode(m)}
                      className={clsx(
                        'flex items-center gap-1.5 px-2.5 py-1 rounded text-xs transition-colors cursor-pointer',
                        active
                          ? 'bg-bg-surface text-text-primary shadow-sm'
                          : 'text-text-tertiary hover:text-text-secondary',
                      )}
                    >
                      <Icon size={11} />
                      {t(`markdown.${m}`)}
                    </button>
                  );
                })}
              </div>
            )}

            {editable && (
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={!isDirty || isSaving}
                className={clsx(
                  'px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer',
                  'bg-accent/15 text-accent hover:bg-accent/25 border border-accent/20',
                  'disabled:opacity-40 disabled:cursor-not-allowed',
                )}
              >
                {isSaving ? t('markdown.saving') : t('markdown.save')}
              </button>
            )}

            <button
              type="button"
              onClick={requestClose}
              className="w-8 h-8 flex items-center justify-center rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
              title={t('markdown.close')}
            >
              <X size={15} />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 min-h-0 flex md-doc-shell">
            {(mode === 'edit' || mode === 'split') && (
              <div
                className={clsx(
                  'flex flex-col min-h-0',
                  mode === 'split' ? 'w-1/2 border-r border-border-subtle' : 'w-full',
                )}
              >
                {/* Editor toolbar */}
                <div className="flex-shrink-0 flex items-center gap-0.5 px-3 py-1.5 border-b border-border-subtle bg-bg-surface/80 backdrop-blur-sm overflow-x-auto scrollbar-thin">
                  <ToolbarButton
                    icon={<Heading1 size={14} />}
                    label={t('markdown.formatH1')}
                    onClick={headingPrefix(1)}
                  />
                  <ToolbarButton
                    icon={<Heading2 size={14} />}
                    label={t('markdown.formatH2')}
                    onClick={headingPrefix(2)}
                  />
                  <ToolbarButton
                    icon={<Heading3 size={14} />}
                    label={t('markdown.formatH3')}
                    onClick={headingPrefix(3)}
                  />
                  <div className="w-px h-4 bg-border-subtle mx-1" />
                  <ToolbarButton
                    icon={<Bold size={14} />}
                    label={t('markdown.formatBold')}
                    onClick={toggleBold}
                    shortcut="\u2318B"
                  />
                  <ToolbarButton
                    icon={<Italic size={14} />}
                    label={t('markdown.formatItalic')}
                    onClick={toggleItalic}
                    shortcut="\u2318I"
                  />
                  <ToolbarButton
                    icon={<Code size={14} />}
                    label={t('markdown.formatCode')}
                    onClick={toggleCode}
                  />
                  <ToolbarButton
                    icon={<LinkIcon size={14} />}
                    label={t('markdown.formatLink')}
                    onClick={insertLink}
                    shortcut="\u2318K"
                  />
                  <div className="w-px h-4 bg-border-subtle mx-1" />
                  <ToolbarButton
                    icon={<Quote size={14} />}
                    label={t('markdown.formatQuote')}
                    onClick={blockquote}
                  />
                  <ToolbarButton
                    icon={<List size={14} />}
                    label={t('markdown.formatBulletList')}
                    onClick={bulletList}
                  />
                  <ToolbarButton
                    icon={<ListOrdered size={14} />}
                    label={t('markdown.formatNumberList')}
                    onClick={numberList}
                  />
                  <ToolbarButton
                    icon={<ListChecks size={14} />}
                    label={t('markdown.formatChecklist')}
                    onClick={checklist}
                  />
                  <ToolbarButton
                    icon={<Minus size={14} />}
                    label={t('markdown.formatHr')}
                    onClick={horizontalRule}
                  />
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
                  <textarea
                    ref={textareaRef}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={handleEditorKeyDown}
                    placeholder={t('markdown.placeholder')}
                    spellCheck={false}
                    autoFocus
                    className="md-doc-editor scrollbar-thin"
                  />
                </div>
              </div>
            )}

            {(mode === 'view' || mode === 'split') && (
              <div
                className={clsx(
                  'min-h-0 overflow-y-auto scrollbar-thin',
                  mode === 'split' ? 'w-1/2' : 'w-full',
                )}
              >
                <div className="md-doc-prose">
                  {previewBody.trim() ? (
                    <MarkdownContent content={previewBody} />
                  ) : (
                    <p className="md-doc-empty">{t('markdown.emptyPreview')}</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex-shrink-0 flex items-center justify-between px-5 py-2 border-t border-border-subtle text-[11px] text-text-tertiary">
            <div className="flex items-center gap-3">
              <span>{t('markdown.shortcutsHint')}</span>
              {filePath && (
                <button
                  type="button"
                  onClick={() => window.cerebro.shell.revealPath(filePath).catch(() => undefined)}
                  className="flex items-center gap-1 hover:text-text-secondary transition-colors cursor-pointer"
                >
                  <FolderOpen size={11} />
                  {t('markdown.revealInFinder')}
                </button>
              )}
            </div>
            <div>
              {t('markdown.wordCount', { count: wordCount })}
            </div>
          </div>
        </div>
      </div>

      {confirmingClose && (
        <AlertModal
          title={t('markdown.closeConfirmTitle')}
          message={t('markdown.closeConfirmMessage')}
          onClose={() => setConfirmingClose(false)}
          actions={[
            {
              label: t('markdown.closeConfirmKeepEditing'),
              onClick: () => setConfirmingClose(false),
            },
            {
              label: t('markdown.closeConfirmDiscard'),
              primary: true,
              variant: 'danger',
              onClick: () => {
                setConfirmingClose(false);
                onClose();
              },
            },
          ]}
        />
      )}
    </>
  );
}
