import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { X, ChevronDown } from 'lucide-react';
import clsx from 'clsx';

interface NewTaskDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: {
    title: string;
    goal: string;
    templateId?: string;
    skipClarification: boolean;
    maxPhases: number;
    maxTurns: number;
    model?: string;
  }) => void;
  /** Pre-fill the goal textarea (e.g. from suggestion chip). */
  initialGoal?: string;
}

const MODELS = [
  { value: '', key: 'newTaskDialog.modelSonnet' },
  { value: 'opus', key: 'newTaskDialog.modelOpus' },
  { value: 'haiku', key: 'newTaskDialog.modelHaiku' },
] as const;

const TEMPLATES = [
  { id: 'presentation', key: 'newTaskDialog.templatePresentation' },
];

const PRESENTATION_DIRECTIVE = `

---
Output format: Build this as a single self-contained static HTML presentation at \`index.html\` in the workspace root. Use inline CSS and JavaScript (no build step, no external files). Emit a \`<run_info>\` block with \`"preview_type": "static"\` so the preview tab renders it directly.`;

export default function NewTaskDialog({ open, onClose, onSubmit, initialGoal }: NewTaskDialogProps) {
  const { t } = useTranslation();
  const [goal, setGoal] = useState(initialGoal ?? '');
  const [skipClarification, setSkipClarification] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [maxPhases, setMaxPhases] = useState(6);
  const [maxTurns, setMaxTurns] = useState(30);
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open && initialGoal) {
      setGoal(initialGoal);
    }
  }, [open, initialGoal]);

  useEffect(() => {
    if (open) {
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [open]);

  const handleSubmit = useCallback(() => {
    const trimmed = goal.trim();
    if (!trimmed) return;
    // Derive title: first sentence or first 60 chars
    const dotIdx = trimmed.indexOf('.');
    const title = dotIdx > 0 && dotIdx < 80
      ? trimmed.slice(0, dotIdx)
      : trimmed.slice(0, 60) + (trimmed.length > 60 ? '...' : '');
    const finalGoal = selectedTemplate === 'presentation'
      ? trimmed + PRESENTATION_DIRECTIVE
      : trimmed;
    onSubmit({
      title,
      goal: finalGoal,
      templateId: selectedTemplate ?? undefined,
      skipClarification,
      maxPhases,
      maxTurns,
      model: model || undefined,
    });
    setGoal('');
    setSelectedTemplate(null);
    setShowAdvanced(false);
    onClose();
  }, [goal, skipClarification, maxPhases, maxTurns, selectedTemplate, model, onSubmit, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') {
      onClose();
    }
  }, [handleSubmit, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="bg-bg-primary border border-border-default rounded-xl shadow-2xl w-full max-w-lg mx-4"
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <h2 className="text-base font-semibold text-text-primary">{t('newTaskDialog.title')}</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-bg-secondary text-text-tertiary hover:text-text-primary transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Goal textarea */}
        <div className="px-5 pb-3">
          <textarea
            ref={textareaRef}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder={t('newTaskDialog.placeholder')}
            className="w-full bg-bg-secondary border border-border-subtle rounded-lg px-3 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary resize-none focus:outline-none focus:ring-1 focus:ring-accent/50 min-h-[100px] max-h-[240px]"
            rows={4}
          />
        </div>

        {/* Template chips */}
        <div className="px-5 pb-3 flex flex-wrap gap-1.5">
          {TEMPLATES.map((tp) => (
            <button
              key={tp.id}
              onClick={() => {
                setSelectedTemplate(tp.id === selectedTemplate ? null : tp.id);
              }}
              className={clsx(
                'text-xs px-2.5 py-1 rounded-full border transition-colors cursor-pointer',
                tp.id === selectedTemplate
                  ? 'bg-accent/15 border-accent/30 text-accent'
                  : 'bg-bg-secondary border-border-subtle text-text-secondary hover:text-text-primary hover:border-border-default',
              )}
            >
              {t(tp.key)}
            </button>
          ))}
        </div>

        {/* Skip clarification toggle */}
        <div className="px-5 pb-2 flex items-center gap-2">
          <button
            onClick={() => setSkipClarification(!skipClarification)}
            className={clsx(
              'relative w-8 h-[18px] rounded-full transition-colors cursor-pointer',
              skipClarification ? 'bg-accent' : 'bg-zinc-600',
            )}
          >
            <div
              className={clsx(
                'absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-transform',
                skipClarification ? 'translate-x-[16px]' : 'translate-x-[2px]',
              )}
            />
          </button>
          <span className="text-xs text-text-secondary">
            {t('newTaskDialog.skipClarification')}
          </span>
        </div>

        {/* Advanced */}
        <div className="px-5 pb-3">
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer"
          >
            <ChevronDown
              size={12}
              className={clsx('transition-transform', showAdvanced && 'rotate-180')}
            />
            {t('newTaskDialog.advanced')}
          </button>
          {showAdvanced && (
            <div className="mt-2 space-y-3">
              <div>
                <label className="text-xs text-text-secondary mb-1 block">
                  {t('newTaskDialog.model')}
                </label>
                <div className="flex gap-1.5">
                  {MODELS.map((m) => (
                    <button
                      key={m.value}
                      onClick={() => setModel(m.value)}
                      className={clsx(
                        'text-xs px-2.5 py-1 rounded-md border transition-colors cursor-pointer',
                        model === m.value
                          ? 'bg-accent/15 border-accent/30 text-accent'
                          : 'bg-bg-secondary border-border-subtle text-text-secondary hover:text-text-primary hover:border-border-default',
                      )}
                    >
                      {t(m.key)}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs text-text-secondary mb-1 block">
                  {t('newTaskDialog.maxPhases', { value: maxPhases })}
                </label>
                <input
                  type="range"
                  min={2}
                  max={8}
                  value={maxPhases}
                  onChange={(e) => setMaxPhases(Number(e.target.value))}
                  className="w-full accent-accent"
                />
              </div>
              <div>
                <label className="text-xs text-text-secondary mb-1 block">
                  {t('newTaskDialog.maxTurns', { value: maxTurns })}
                </label>
                <input
                  type="range"
                  min={5}
                  max={50}
                  step={5}
                  value={maxTurns}
                  onChange={(e) => setMaxTurns(Number(e.target.value))}
                  className="w-full accent-accent"
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border-subtle">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded-md text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSubmit}
            disabled={!goal.trim()}
            className="px-4 py-1.5 text-sm rounded-md bg-accent text-white font-medium hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            {t('newTaskDialog.startTask')}
          </button>
        </div>
      </div>
    </div>
  );
}
