import type { LucideIcon } from 'lucide-react';

interface EmptySectionProps {
  sectionTitle: string;
  sectionDescription: string;
  icon: LucideIcon;
  comingSoonText: string;
}

export default function EmptySection({
  sectionTitle,
  sectionDescription,
  icon: Icon,
  comingSoonText,
}: EmptySectionProps) {
  return (
    <div>
      <h2 className="text-lg font-medium text-text-primary">{sectionTitle}</h2>
      <p className="text-sm text-text-secondary mt-1 leading-relaxed">
        {sectionDescription}
      </p>

      <div className="mt-6 border-2 border-dashed border-border-default rounded-xl py-12 px-6 flex flex-col items-center text-center">
        <div className="w-11 h-11 rounded-xl bg-bg-elevated border border-border-subtle flex items-center justify-center mb-4">
          <Icon size={18} className="text-text-tertiary" />
        </div>
        <span className="text-xs font-medium text-text-tertiary uppercase tracking-wide mb-2">
          Coming Soon
        </span>
        <p className="text-sm text-text-tertiary max-w-sm leading-relaxed">
          {comingSoonText}
        </p>
      </div>
    </div>
  );
}
