import { useState } from 'react';
import { FileText, Pencil } from 'lucide-react';
import { useMemory } from '../../../context/MemoryContext';
import ContextFileEditor from './ContextFileEditor';

interface ContextFileCardProps {
  fileKey: string;
  title: string;
  description: string;
  placeholder: string;
}

export default function ContextFileCard({
  fileKey,
  title,
  description,
  placeholder,
}: ContextFileCardProps) {
  const { contextFiles } = useMemory();
  const [isEditing, setIsEditing] = useState(false);

  const file = contextFiles[fileKey];
  const hasContent = file && file.content.trim().length > 0;

  if (isEditing) {
    return (
      <ContextFileEditor
        fileKey={fileKey}
        title={title}
        initialContent={file?.content ?? ''}
        placeholder={placeholder}
        onClose={() => setIsEditing(false)}
      />
    );
  }

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-surface p-4 transition-colors hover:border-border-default">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="flex items-center justify-center w-8 h-8 rounded-md bg-accent/10 text-accent flex-shrink-0 mt-0.5">
            <FileText size={16} />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-text-primary">{title}</div>
            {hasContent ? (
              <p className="text-xs text-text-secondary mt-1 line-clamp-2">
                {file.content.slice(0, 150)}
                {file.content.length > 150 ? '...' : ''}
              </p>
            ) : (
              <p className="text-xs text-text-tertiary mt-1">{description}</p>
            )}
          </div>
        </div>
        <button
          onClick={() => setIsEditing(true)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-text-secondary
                     hover:text-text-primary hover:bg-white/[0.06] transition-colors flex-shrink-0 cursor-pointer"
        >
          <Pencil size={12} />
          {hasContent ? 'Edit' : 'Add'}
        </button>
      </div>
    </div>
  );
}
