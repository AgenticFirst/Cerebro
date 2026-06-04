import { memo, useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { type NodeProps } from '@xyflow/react';
import { StickyNote } from 'lucide-react';
import clsx from 'clsx';
import Tooltip from '../../ui/Tooltip';

interface StickyNoteData {
  text: string;
  width?: number;
  height?: number;
}

function StickyNoteNodeComponent({ data, selected, id }: NodeProps) {
  const { t } = useTranslation();
  const d = data as StickyNoteData;
  const [isEditing, setIsEditing] = useState(false);
  const [text, setText] = useState(d.text ?? '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync text state with data
  useEffect(() => {
    setText(d.text ?? '');
  }, [d.text]);

  const handleDoubleClick = useCallback(() => {
    setIsEditing(true);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  const handleBlur = useCallback(() => {
    setIsEditing(false);
    // Propagate via custom event — the hook will listen for this
    const event = new CustomEvent('stickyNoteUpdate', {
      detail: { id, text },
    });
    window.dispatchEvent(event);
  }, [id, text]);

  const wrapper = (
    <div
      className={clsx(
        'rounded-md border transition-all duration-150 cursor-default',
        selected
          ? 'border-yellow-400 shadow-[0_0_8px_rgba(234,179,8,0.3)]'
          : 'border-yellow-600/20 hover:border-yellow-500/40',
      )}
      style={{
        width: d.width ?? 200,
        minHeight: d.height ?? 120,
        backgroundColor: 'rgba(234, 179, 8, 0.08)',
      }}
      onDoubleClick={handleDoubleClick}
    >
      {/* Header */}
      <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1">
        <StickyNote size={11} className="text-yellow-500/60" />
        <span className="text-[10px] font-medium text-yellow-500/60 uppercase tracking-wider">
          Note
        </span>
      </div>

      {/* Content */}
      <div className="px-2.5 pb-2.5">
        {isEditing ? (
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                textareaRef.current?.blur();
              }
            }}
            className="w-full bg-transparent text-xs text-text-secondary resize-none focus:outline-none min-h-[60px]"
            placeholder="Type a note..."
          />
        ) : (
          <p className="text-xs text-text-secondary whitespace-pre-wrap min-h-[60px]">
            {text || <span className="text-text-tertiary italic">Double-click to edit...</span>}
          </p>
        )}
      </div>
    </div>
  );

  return (
    <Tooltip label={t('routineTooltips.stickyNote')} side="top" delay={500} disabled={isEditing}>
      {wrapper}
    </Tooltip>
  );
}

export default memo(StickyNoteNodeComponent);
