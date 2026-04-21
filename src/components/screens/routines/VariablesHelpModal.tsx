/**
 * Plain-language tutorial for how step variables work. Opened from the
 * "Available variables" label in any step-config panel (Ask AI, Send
 * Notification, and any future templated action). The example and copy
 * mirror the real Ask AI → Send Notification flow so what users see in
 * the modal matches what they'll build on the canvas.
 */

import { X, Sparkles, ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface VariablesHelpModalProps {
  onClose: () => void;
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <code className="px-1.5 py-0.5 rounded font-mono text-[11px] bg-accent/10 text-accent border border-accent/20">
      {children}
    </code>
  );
}

function ExampleCard({
  title,
  lines,
}: {
  title: string;
  lines: Array<{ label: string; value: React.ReactNode }>;
}) {
  return (
    <div className="flex-1 min-w-0 rounded-lg bg-bg-base border border-border-subtle p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-accent mb-2">
        {title}
      </div>
      <div className="space-y-2">
        {lines.map((l) => (
          <div key={l.label} className="text-[11px] leading-relaxed">
            <div className="text-text-tertiary">{l.label}</div>
            <div className="text-text-secondary break-words">{l.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  body,
}: {
  n: number;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-accent/10 text-accent text-[10px] font-semibold flex items-center justify-center">
        {n}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-text-primary">{title}</div>
        <div className="text-[11px] text-text-secondary leading-relaxed mt-0.5">
          {body}
        </div>
      </div>
    </li>
  );
}

export default function VariablesHelpModal({ onClose }: VariablesHelpModalProps) {
  const { t } = useTranslation();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="relative bg-bg-surface border border-border-subtle rounded-xl shadow-2xl w-full max-w-lg mx-4 animate-fade-in max-h-[85vh] overflow-y-auto scrollbar-thin">
        <button
          onClick={onClose}
          className="absolute top-3 right-3 p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors z-10"
          aria-label={t('variablesHelp.close')}
        >
          <X size={14} />
        </button>

        <div className="px-5 pt-5 pb-4">
          {/* Header */}
          <div className="flex items-center gap-3 mb-3">
            <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0">
              <Sparkles size={16} className="text-accent" />
            </div>
            <h3 className="text-sm font-medium text-text-primary">
              {t('variablesHelp.title')}
            </h3>
          </div>

          {/* Intro */}
          <p className="text-xs text-text-secondary leading-relaxed mb-4">
            {t('variablesHelp.introBefore')}{' '}
            <Chip>{'{{name}}'}</Chip>{' '}
            {t('variablesHelp.introAfter')}
          </p>

          {/* Example */}
          <div className="mb-4">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary mb-2">
              {t('variablesHelp.exampleLabel')}
            </div>
            <div className="flex flex-col sm:flex-row gap-2 items-stretch">
              <ExampleCard
                title={t('variablesHelp.step1Title')}
                lines={[
                  {
                    label: t('variablesHelp.step1PromptLabel'),
                    value: <em>"{t('variablesHelp.step1PromptValue')}"</em>,
                  },
                  {
                    label: t('variablesHelp.step1OutputLabel'),
                    value: (
                      <>
                        <Chip>reply</Chip> ={' '}
                        <em>"{t('variablesHelp.step1OutputValue')}"</em>
                      </>
                    ),
                  },
                ]}
              />
              <div className="hidden sm:flex items-center px-1 text-accent">
                <ArrowRight size={14} />
              </div>
              <ExampleCard
                title={t('variablesHelp.step2Title')}
                lines={[
                  {
                    label: t('variablesHelp.step2BodyLabel'),
                    value: (
                      <>
                        {t('variablesHelp.step2BodyPrefix')}{' '}
                        <Chip>{'{{reply}}'}</Chip>
                      </>
                    ),
                  },
                  {
                    label: t('variablesHelp.step2RuntimeLabel'),
                    value: (
                      <em>
                        "{t('variablesHelp.step2BodyPrefix')}{' '}
                        {t('variablesHelp.step1OutputValue')}"
                      </em>
                    ),
                  },
                ]}
              />
            </div>
            <p className="mt-2 text-[11px] text-text-tertiary leading-relaxed">
              {t('variablesHelp.exampleCaption')}
            </p>
          </div>

          {/* How to use them */}
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary mb-2">
              {t('variablesHelp.howLabel')}
            </div>
            <ol className="space-y-2.5">
              <Step
                n={1}
                title={t('variablesHelp.tip1Title')}
                body={t('variablesHelp.tip1Body')}
              />
              <Step
                n={2}
                title={t('variablesHelp.tip2Title')}
                body={
                  <>
                    {t('variablesHelp.tip2BodyBefore')}{' '}
                    <Chip>{'{{name}}'}</Chip>{' '}
                    {t('variablesHelp.tip2BodyAfter')}
                  </>
                }
              />
              <Step
                n={3}
                title={t('variablesHelp.tip3Title')}
                body={
                  <>
                    {t('variablesHelp.tip3BodyBefore')}{' '}
                    <Chip>{'{{name}}'}</Chip>{' '}
                    {t('variablesHelp.tip3BodyAfter')}
                  </>
                }
              />
            </ol>
          </div>
        </div>

        <div className="border-t border-border-subtle px-5 py-3 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-md text-xs font-medium bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors cursor-pointer"
          >
            {t('variablesHelp.gotIt')}
          </button>
        </div>
      </div>
    </div>
  );
}
