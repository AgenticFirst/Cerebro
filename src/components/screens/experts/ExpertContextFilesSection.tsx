import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Plus, Trash2, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';

import type { ContextFileKind, ExpertContextFile } from '../../../types/experts';

interface ApiContextFile {
  id: string;
  expert_id: string;
  file_item_id: string;
  kind: ContextFileKind;
  sort_order: number;
  char_count: number;
  truncated: boolean;
  created_at: string;
  file_name: string;
  file_ext: string;
  file_mime: string | null;
  file_size_bytes: number;
  file_storage_path: string;
  parsed_text_path: string | null;
}

function fromApi(row: ApiContextFile): ExpertContextFile {
  return {
    id: row.id,
    expertId: row.expert_id,
    fileItemId: row.file_item_id,
    kind: row.kind,
    sortOrder: row.sort_order,
    charCount: row.char_count,
    truncated: row.truncated,
    createdAt: row.created_at,
    fileName: row.file_name,
    fileExt: row.file_ext,
    fileMime: row.file_mime,
    fileSizeBytes: row.file_size_bytes,
    fileStoragePath: row.file_storage_path,
    parsedTextPath: row.parsed_text_path,
  };
}

interface Props {
  expertId: string;
  isLocked?: boolean;
}

export default function ExpertContextFilesSection({ expertId, isLocked = false }: Props) {
  const { t } = useTranslation();
  const [files, setFiles] = useState<ExpertContextFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.cerebro.invoke({
        method: 'GET',
        path: `/experts/${expertId}/context-files`,
      });
      if (res.ok) {
        setFiles((res.data as ApiContextFile[]).map(fromApi));
      }
    } finally {
      setLoading(false);
    }
  }, [expertId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleFiles = useCallback(
    async (picked: FileList | null) => {
      if (!picked || picked.length === 0) return;
      setUploading(true);
      try {
        for (const f of Array.from(picked)) {
          const filePath = await window.cerebro.getPathForFile(f);
          if (!filePath) continue;
          // 1) Register the bytes as a FileItem (workspace pointer + sha + MIME sniff).
          const reg = await window.cerebro.invoke({
            method: 'POST',
            path: '/files/items/from-path',
            body: { file_path: filePath, source: 'expert-context' },
          });
          if (!reg.ok) continue;
          const fileItemId = (reg.data as { id: string }).id;
          // 2) Pre-parse so the sidecar exists before the installer reads it.
          await window.cerebro.invoke({
            method: 'POST',
            path: '/files/parse',
            body: { file_path: filePath },
          });
          // 3) Attach to the expert.
          await window.cerebro.invoke({
            method: 'POST',
            path: `/experts/${expertId}/context-files`,
            body: { file_item_id: fileItemId, kind: 'reference' },
          });
        }
        // 4) Re-materialize the expert's <slug>.md so the parsed text shows up.
        await window.cerebro.installer.syncExpert(expertId).catch(() => {/* best-effort */});
        await refresh();
      } finally {
        setUploading(false);
        if (inputRef.current) inputRef.current.value = '';
      }
    },
    [expertId, refresh],
  );

  const toggleKind = async (cf: ExpertContextFile) => {
    const next: ContextFileKind = cf.kind === 'template' ? 'reference' : 'template';
    await window.cerebro.invoke({
      method: 'PATCH',
      path: `/experts/${expertId}/context-files/${cf.id}`,
      body: { kind: next },
    });
    await window.cerebro.installer.syncExpert(expertId).catch(() => {/* best-effort */});
    await refresh();
  };

  const detach = async (cf: ExpertContextFile) => {
    await window.cerebro.invoke({
      method: 'DELETE',
      path: `/experts/${expertId}/context-files/${cf.id}`,
    });
    await window.cerebro.installer.syncExpert(expertId).catch(() => {/* best-effort */});
    await refresh();
  };

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-text-tertiary leading-snug">
        {t('experts.referenceDocsHelp')}
      </p>

      {files.length === 0 && !loading && (
        <div className="text-xs text-text-tertiary italic px-2 py-3">
          {t('experts.noReferenceFiles')}
        </div>
      )}

      <ul className="space-y-1.5">
        {files.map((cf) => (
          <li
            key={cf.id}
            className="flex items-center gap-2 px-2.5 py-2 rounded-md bg-bg-elevated border border-border-subtle"
          >
            <FileText size={14} className="text-text-secondary shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-xs text-text-primary truncate" title={cf.fileName}>
                {cf.fileName}
              </div>
              <div className="text-[10px] text-text-tertiary flex items-center gap-2">
                <span>{(cf.fileSizeBytes / 1024).toFixed(0)} KB</span>
                {cf.charCount > 0 && <span>· {cf.charCount.toLocaleString()} chars</span>}
                {cf.truncated && (
                  <span className="flex items-center gap-1 text-amber-500">
                    <AlertTriangle size={10} />
                    {t('experts.referenceTruncated')}
                  </span>
                )}
              </div>
            </div>
            <button
              onClick={() => toggleKind(cf)}
              disabled={isLocked}
              className={clsx(
                'text-[10px] px-2 py-0.5 rounded border transition-colors',
                cf.kind === 'template'
                  ? 'border-accent text-accent bg-accent/10 hover:bg-accent/20'
                  : 'border-border-default text-text-secondary hover:bg-bg-base',
                isLocked && 'opacity-60 cursor-not-allowed',
              )}
            >
              {cf.kind === 'template'
                ? t('experts.referenceKindTemplate')
                : t('experts.referenceKindReference')}
            </button>
            <button
              onClick={() => detach(cf)}
              disabled={isLocked}
              title={t('experts.removeReferenceFile')}
              className="p-1 text-text-tertiary hover:text-red-400 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <Trash2 size={13} />
            </button>
          </li>
        ))}
      </ul>

      <div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".docx,.xlsx,.pptx,.pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.md"
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
          disabled={isLocked || uploading}
        />
        <button
          onClick={() => inputRef.current?.click()}
          disabled={isLocked || uploading}
          className="flex items-center gap-1.5 text-xs text-accent hover:text-accent-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <Plus size={13} />
          {uploading ? t('experts.addingReferenceFile') : t('experts.addReferenceFile')}
        </button>
      </div>
    </div>
  );
}
