import { useState } from 'react';
import { Save, X } from 'lucide-react';
import { useMemory } from '../../../context/MemoryContext';

interface ContextFileEditorProps {
  fileKey: string;
  title: string;
  initialContent: string;
  placeholder: string;
  onClose: () => void;
}

export default function ContextFileEditor({
  fileKey,
  title,
  initialContent,
  placeholder,
  onClose,
}: ContextFileEditorProps) {
  const { saveContextFile, deleteContextFile } = useMemory();
  const [content, setContent] = useState(initialContent);
  const [isSaving, setIsSaving] = useState(false);

  const isDirty = content !== initialContent;

  const handleSave = async () => {
    setIsSaving(true);
    try {
      if (content.trim()) {
        await saveContextFile(fileKey, content);
      } else {
        await deleteContextFile(fileKey);
      }
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-accent/30 bg-bg-surface p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-text-primary">{title}</span>
        <div className="flex items-center gap-2">
          <button
            onClick={onClose}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs text-text-secondary
                       hover:text-text-primary hover:bg-white/[0.06] transition-colors cursor-pointer"
          >
            <X size={12} />
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!isDirty || isSaving}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium
                       bg-accent/15 text-accent hover:bg-accent/25 transition-colors
                       disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            <Save size={12} />
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={placeholder}
        rows={8}
        className="w-full bg-bg-base border border-border-subtle rounded-md px-3 py-2.5
                   text-sm text-text-secondary font-mono leading-relaxed
                   placeholder:text-text-tertiary/50 resize-y min-h-[120px]
                   focus:outline-none focus:border-accent/40 transition-colors"
      />
      <p className="text-[11px] text-text-tertiary mt-2">
        Write in markdown. This content is included in every conversation as context for Cerebro.
      </p>
    </div>
  );
}
