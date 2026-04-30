import { useTranslation } from 'react-i18next';
import { previewKindFor } from '../screens/files/utils';
import MarkdownContent from '../chat/MarkdownContent';

export type PreviewKind = ReturnType<typeof previewKindFor>;

export interface FilePreviewBodyProps {
  kind: PreviewKind;
  name: string;
  ext: string;
  previewUrl: string | null;
  textContent: string | null;
  loadError: string | null;
  onOpenExternal: () => void;
  /** When true, markdown is rendered inline via MarkdownContent instead of
   *  triggering the global MarkdownDocument overlay. The chat preview modal
   *  passes this; the Files-screen drawer leaves it false. */
  markdownInline?: boolean;
}

export default function FilePreviewBody({
  kind,
  name,
  ext,
  previewUrl,
  textContent,
  loadError,
  onOpenExternal,
  markdownInline,
}: FilePreviewBodyProps) {
  const { t } = useTranslation();

  if (loadError) {
    return <div className="p-6 text-xs text-red-400">{loadError}</div>;
  }

  if (kind === 'markdown') {
    if (markdownInline) {
      if (textContent === null) {
        return (
          <div className="flex-1 flex items-center justify-center text-xs text-text-tertiary">
            {t('common.loading')}
          </div>
        );
      }
      return (
        <div className="flex-1 overflow-auto p-6">
          <MarkdownContent content={textContent} />
        </div>
      );
    }
    return <div className="p-6 text-xs text-text-tertiary">{t('common.loading')}</div>;
  }

  if (kind === 'image' && previewUrl) {
    return (
      <div className="flex-1 flex items-center justify-center overflow-auto bg-black/30 p-4">
        <img src={previewUrl} alt={name} className="max-w-full max-h-full object-contain" />
      </div>
    );
  }

  if (kind === 'video' && previewUrl) {
    return (
      <div className="flex-1 flex items-center justify-center overflow-auto bg-black p-4">
        <video src={previewUrl} controls className="max-w-full max-h-full" />
      </div>
    );
  }

  if (kind === 'audio' && previewUrl) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <audio src={previewUrl} controls className="w-full max-w-md" />
      </div>
    );
  }

  if (kind === 'html' && previewUrl) {
    return (
      <iframe
        src={previewUrl}
        className="flex-1 w-full bg-white border-0"
        sandbox="allow-scripts allow-same-origin allow-forms"
        title={name}
      />
    );
  }

  if (kind === 'pdf' && previewUrl) {
    return <iframe src={previewUrl} className="flex-1 w-full bg-bg-surface border-0" title={name} />;
  }

  if (kind === 'text' && textContent !== null) {
    return (
      <pre className="flex-1 overflow-auto p-3 text-[11px] text-text-secondary font-mono leading-relaxed whitespace-pre-wrap bg-bg-surface/40">
        {textContent || '(empty)'}
      </pre>
    );
  }

  if (kind === 'binary') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-text-tertiary">
        <p className="text-xs">{t('files.previewBinary', { ext: ext || 'unknown' })}</p>
        <button
          onClick={onOpenExternal}
          className="px-3 py-1.5 rounded-md text-xs bg-accent/10 text-accent border border-accent/20 hover:bg-accent/20 cursor-pointer"
        >
          {t('files.previewOpenExternal')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex items-center justify-center text-xs text-text-tertiary">
      {t('common.loading')}
    </div>
  );
}
