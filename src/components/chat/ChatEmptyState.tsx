import Lottie from 'lottie-react';
import { useTranslation } from 'react-i18next';
import { ListChecks, Users, Zap, BookOpen } from 'lucide-react';
import astronautAnimation from '../../assets/lottie/astronaut.json';

export default function ChatEmptyState() {
  const { t } = useTranslation();

  const capabilities = [
    { icon: ListChecks, labelKey: 'chat.welcomeCapPlan', descKey: 'chat.welcomeCapPlanDesc' },
    { icon: Users, labelKey: 'chat.welcomeCapDelegate', descKey: 'chat.welcomeCapDelegateDesc' },
    { icon: Zap, labelKey: 'chat.welcomeCapRoutines', descKey: 'chat.welcomeCapRoutinesDesc' },
    { icon: BookOpen, labelKey: 'chat.welcomeCapMemory', descKey: 'chat.welcomeCapMemoryDesc' },
  ];

  return (
    <div className="flex w-full flex-col items-center px-4 pt-6 pb-4">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[360px]"
        style={{
          background:
            'radial-gradient(ellipse 55% 45% at 50% 35%, rgba(6,182,212,0.08) 0%, transparent 70%)',
        }}
      />

      <div className="relative h-[220px] w-[220px] select-none">
        <div
          aria-hidden
          className="absolute inset-0 rounded-full blur-3xl"
          style={{
            background:
              'radial-gradient(circle at 50% 55%, rgba(6,182,212,0.28) 0%, rgba(6,182,212,0.08) 45%, transparent 72%)',
          }}
        />
        <Lottie
          animationData={astronautAnimation}
          loop
          autoplay
          className="relative z-10 h-full w-full"
          rendererSettings={{ preserveAspectRatio: 'xMidYMid meet' }}
        />
      </div>

      <h1 className="mt-2 text-center text-[26px] font-light leading-tight tracking-tight text-text-primary">
        {t('chat.welcomeTitle')}
      </h1>
      <p className="mt-2 max-w-md text-center text-sm leading-relaxed text-text-secondary">
        {t('chat.welcomeSubtitle')}
      </p>

      <div className="mt-6 grid w-full max-w-xl grid-cols-2 gap-2 sm:grid-cols-4">
        {capabilities.map((cap) => {
          const Icon = cap.icon;
          return (
            <div
              key={cap.labelKey}
              className="group flex flex-col items-center gap-1.5 rounded-xl border border-border-subtle bg-bg-surface/60 px-3 py-3.5 backdrop-blur-sm transition-all hover:border-accent/30 hover:bg-bg-surface"
            >
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10 text-accent transition-colors group-hover:bg-accent/15">
                <Icon size={14} strokeWidth={2} />
              </div>
              <span className="text-center text-[12px] font-medium leading-tight text-text-primary">
                {t(cap.labelKey)}
              </span>
              <span className="text-center text-[10.5px] leading-snug text-text-tertiary">
                {t(cap.descKey)}
              </span>
            </div>
          );
        })}
      </div>

      <p className="mt-5 text-center text-[11px] text-text-tertiary">
        {t('chat.welcomeHint')}
      </p>
    </div>
  );
}
