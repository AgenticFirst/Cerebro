import { useState, useRef, useCallback, type KeyboardEvent, type ChangeEvent } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import clsx from 'clsx';
import ModelSelector from './ModelSelector';

interface ChatInputProps {
  onSend: (content: string) => void;
  isStreaming?: boolean;
}

export default function ChatInput({ onSend, isStreaming = false }: ChatInputProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
    if (!trimmed || isStreaming) return;
    onSend(trimmed);
    setValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, isStreaming, onSend]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const hasContent = value.trim().length > 0;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center px-1">
        <ModelSelector />
      </div>
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
        placeholder="Send a message..."
        rows={1}
        className={clsx(
          'flex-1 resize-none bg-transparent text-text-primary',
          'placeholder:text-text-tertiary',
          'outline-none',
          'text-sm leading-6',
        )}
      />
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
      </div>
    </div>
  );
}
