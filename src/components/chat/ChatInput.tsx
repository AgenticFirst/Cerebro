import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  forwardRef,
  type KeyboardEvent,
  type ChangeEvent,
  type ClipboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUp, Square, Paperclip } from 'lucide-react';
import clsx from 'clsx';
import AttachmentChip from './AttachmentChip';
import SpeedSelector from './SpeedSelector';
import type { AttachmentInfo } from '../../types/attachments';
import { generateId } from '../../context/chat-helpers';
import { useToast } from '../../context/ToastContext';

interface ChatInputProps {
  onSend: (content: string) => void;
  onStop?: () => void;
  isStreaming?: boolean;
  placeholder?: string;
  /**
   * Optional controlled draft. When `onDraftChange` is provided the textarea
   * reads its value from `draftValue` (persisted by the parent / ChatContext)
   * instead of local state, so an unsent message survives unmount. Omit both
   * to keep the original uncontrolled behavior.
   */
  draftValue?: string;
  onDraftChange?: (value: string) => void;
}

export interface ChatInputHandle {
  addAttachments: (files: AttachmentInfo[]) => void;
}

const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  { onSend, onStop, isStreaming = false, placeholder, draftValue, onDraftChange },
  ref,
) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  // Controlled when the parent owns the draft (onDraftChange present); otherwise
  // fall back to local state so callers that don't persist drafts still work.
  const isControlled = onDraftChange !== undefined;
  const [internalValue, setInternalValue] = useState('');
  const value = isControlled ? (draftValue ?? '') : internalValue;
  const setValue = useCallback(
    (v: string) => {
      if (isControlled) onDraftChange!(v);
      else setInternalValue(v);
    },
    [isControlled, onDraftChange],
  );
  const [attachments, setAttachments] = useState<AttachmentInfo[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addAttachments = useCallback((files: AttachmentInfo[]) => {
    setAttachments((prev) => {
      const existingPaths = new Set(prev.map((a) => a.filePath));
      const newFiles = files.filter((f) => !existingPaths.has(f.filePath));
      return [...prev, ...newFiles];
    });
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  useImperativeHandle(ref, () => ({ addAttachments }), [addAttachments]);

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const maxHeight = 6 * 24; // ~6 rows
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  }, []);

  // Resize to fit a restored draft. The per-keystroke handler below only fires
  // on user input, so without this a multi-line draft would show as a single
  // collapsed row when the input remounts (screen nav) or its controlled value
  // changes from outside (switching conversations).
  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    adjustHeight();
  };

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if ((!trimmed && attachments.length === 0) || isStreaming) return;

    const atRefs = attachments.map((a) => `@${a.filePath}`).join('\n');
    const fullContent = [atRefs, trimmed].filter(Boolean).join('\n\n');

    onSend(fullContent);
    setValue('');
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, attachments, isStreaming, onSend]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFilePickerClick = () => {
    fileInputRef.current?.click();
  };

  const handlePaste = useCallback(
    async (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) imageFiles.push(f);
        }
      }
      if (imageFiles.length === 0) return; // let normal text paste run

      e.preventDefault();
      const saved: AttachmentInfo[] = [];
      let sawTooLarge = false;
      let sawOtherError = false;
      for (const file of imageFiles) {
        try {
          const buf = await file.arrayBuffer();
          const { filePath, fileName, size } = await window.cerebro.saveClipboardImage({
            bytes: buf,
            mime: file.type,
          });
          const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
          saved.push({ id: generateId(), filePath, fileName, fileSize: size, extension: ext });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('too large')) sawTooLarge = true;
          else sawOtherError = true;
          console.warn('[ChatInput] clipboard image save failed:', err);
        }
      }
      if (saved.length > 0) addAttachments(saved);
      if (sawTooLarge) addToast(t('chat.pasteImageTooLarge'), 'error');
      else if (sawOtherError) addToast(t('chat.pasteImageFailed'), 'error');
    },
    [addAttachments, addToast, t],
  );

  const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const newAttachments: AttachmentInfo[] = [];

    for (const file of files) {
      const filePath = window.cerebro.getPathForFile(file);
      if (!filePath) continue;
      const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
      newAttachments.push({
        id: generateId(),
        filePath,
        fileName: file.name,
        fileSize: file.size,
        extension: ext,
      });
    }

    if (newAttachments.length > 0) {
      addAttachments(newAttachments);
    }

    // Reset input so the same file can be re-selected
    e.target.value = '';
  };

  const hasContent = value.trim().length > 0 || attachments.length > 0;

  return (
    <div className="flex flex-col gap-1.5">
      {/* Attachment chips */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 animate-fade-in">
          {attachments.map((att) => (
            <AttachmentChip key={att.id} attachment={att} onRemove={removeAttachment} />
          ))}
        </div>
      )}

      <div
        className={clsx(
          'relative flex items-center gap-2 rounded-xl border px-4 py-3',
          'bg-bg-elevated border-border-subtle',
          'transition-all duration-200',
          'focus-within:border-border-accent focus-within:glow-cyan',
        )}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder ?? t('chat.sendPlaceholder')}
          rows={1}
          className={clsx(
            'flex-1 resize-none bg-transparent text-text-primary',
            'placeholder:text-text-tertiary',
            'outline-none',
            'text-sm leading-6',
          )}
        />
        <SpeedSelector />
        <button
          onClick={handleFilePickerClick}
          disabled={isStreaming}
          className={clsx(
            'flex-shrink-0 flex items-center justify-center',
            'w-8 h-8 rounded-lg transition-all duration-150',
            'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover',
            'disabled:opacity-30 disabled:cursor-default',
          )}
          title={t('chat.attachFiles')}
        >
          <Paperclip size={15} />
        </button>
        <button
          onClick={isStreaming ? onStop : handleSend}
          disabled={!hasContent && !isStreaming}
          title={isStreaming ? t('chat.stop') : t('chat.send')}
          aria-label={isStreaming ? t('chat.stop') : t('chat.send')}
          className={clsx(
            'flex-shrink-0 flex items-center justify-center',
            'w-8 h-8 rounded-lg transition-all duration-150',
            isStreaming
              ? 'bg-text-secondary/20 text-text-primary hover:bg-text-secondary/30 cursor-pointer'
              : hasContent
                ? 'bg-accent text-bg-base hover:bg-accent-hover cursor-pointer'
                : 'bg-bg-hover text-text-tertiary cursor-default',
          )}
        >
          {isStreaming ? <Square size={14} /> : <ArrowUp size={16} />}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileInputChange}
          className="hidden"
        />
      </div>
    </div>
  );
});

export default ChatInput;
