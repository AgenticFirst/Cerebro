import { useState, useRef, useCallback, useImperativeHandle, forwardRef, type KeyboardEvent, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUp, Square, Paperclip, HelpCircle } from 'lucide-react';
import clsx from 'clsx';
import AttachmentChip from './AttachmentChip';
import CapabilitiesModal from './CapabilitiesModal';
import type { AttachmentInfo } from '../../types/attachments';
import { generateId } from '../../context/chat-helpers';

interface ChatInputProps {
  onSend: (content: string) => void;
  isStreaming?: boolean;
  placeholder?: string;
}

export interface ChatInputHandle {
  addAttachments: (files: AttachmentInfo[]) => void;
}

const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(
  function ChatInput({ onSend, isStreaming = false, placeholder }, ref) {
    const { t } = useTranslation();
    const [value, setValue] = useState('');
    const [attachments, setAttachments] = useState<AttachmentInfo[]>([]);
    const [helpOpen, setHelpOpen] = useState(false);
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
            placeholder={placeholder ?? t('chat.sendPlaceholder')}
            rows={1}
            className={clsx(
              'flex-1 resize-none bg-transparent text-text-primary',
              'placeholder:text-text-tertiary',
              'outline-none',
              'text-sm leading-6',
            )}
          />
          <button
            onClick={() => setHelpOpen(true)}
            className={clsx(
              'flex-shrink-0 flex items-center justify-center',
              'w-8 h-8 rounded-lg transition-all duration-150',
              'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover',
            )}
            title={t('chat.helpChip.tooltip')}
            aria-label={t('chat.helpChip.label')}
          >
            <HelpCircle size={15} />
          </button>
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
            onClick={isStreaming ? undefined : handleSend}
            disabled={!hasContent && !isStreaming}
            className={clsx(
              'flex-shrink-0 flex items-center justify-center',
              'w-8 h-8 rounded-lg transition-all duration-150',
              isStreaming
                ? 'bg-text-secondary/20 text-text-secondary cursor-default'
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
        {helpOpen && <CapabilitiesModal onClose={() => setHelpOpen(false)} />}
      </div>
    );
  },
);

export default ChatInput;
