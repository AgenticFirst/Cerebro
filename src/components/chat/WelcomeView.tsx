import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ListChecks, Users, Zap, BookOpen } from 'lucide-react';
import ChatInput, { type ChatInputHandle } from './ChatInput';
import { useDropZone } from '../../hooks/useDropZone';
import { useChat } from '../../context/ChatContext';

interface WelcomeViewProps {
  onSend: (content: string) => void;
}

export default function WelcomeView({ onSend }: WelcomeViewProps) {
  const { t } = useTranslation();
  const chatInputRef = useRef<ChatInputHandle>(null);
  const { setActiveExpertId } = useChat();

  // Welcome view starts a fresh Cerebro chat — ensure no expert is pinned.
  useEffect(() => {
    setActiveExpertId(null);
  }, [setActiveExpertId]);

  const { isDragOver, dropProps } = useDropZone({
    onDrop: (files) => chatInputRef.current?.addAttachments(files),
  });

  const capabilities = [
    { icon: ListChecks, labelKey: 'chat.welcomeCapPlan', descKey: 'chat.welcomeCapPlanDesc' },
    { icon: Users, labelKey: 'chat.welcomeCapDelegate', descKey: 'chat.welcomeCapDelegateDesc' },
    { icon: Zap, labelKey: 'chat.welcomeCapRoutines', descKey: 'chat.welcomeCapRoutinesDesc' },
    { icon: BookOpen, labelKey: 'chat.welcomeCapMemory', descKey: 'chat.welcomeCapMemoryDesc' },
  ];

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-4 relative" {...dropProps}>
      <div className="w-full max-w-2xl">
        <h1 className="text-3xl font-light text-text-primary text-center mb-3">
          {t('chat.welcomeTitle')}
        </h1>
        <p className="text-sm text-text-secondary text-center mb-8">
          {t('chat.welcomeSubtitle')}
        </p>
        <ChatInput ref={chatInputRef} onSend={onSend} />

        <div className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-2">
          {capabilities.map((cap) => {
            const Icon = cap.icon;
            return (
              <div
                key={cap.labelKey}
                className="flex flex-col items-center gap-1.5 px-3 py-3 rounded-lg bg-bg-surface/60 border border-border-subtle"
              >
                <Icon size={16} className="text-accent" strokeWidth={1.8} />
                <span className="text-[12px] font-medium text-text-primary text-center leading-tight">
                  {t(cap.labelKey)}
                </span>
                <span className="text-[10.5px] text-text-tertiary text-center leading-snug">
                  {t(cap.descKey)}
                </span>
              </div>
            );
          })}
        </div>

        <p className="mt-5 text-[11px] text-text-tertiary text-center">
          {t('chat.welcomeHint')}
        </p>
      </div>

      {isDragOver && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-accent/5 border-2 border-dashed border-accent/40 rounded-xl pointer-events-none">
          <span className="text-sm font-medium text-accent">{t('chat.dropToAttach')}</span>
        </div>
      )}
    </div>
  );
}
