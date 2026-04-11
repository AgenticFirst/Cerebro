import { Bot } from 'lucide-react';
import type { VoiceSessionState } from '../../../voice/types';

const DOMAIN_COLORS: Record<string, string> = {
  productivity: '#3b82f6',
  health: '#10b981',
  finance: '#f59e0b',
  creative: '#a855f7',
  engineering: '#f97316',
  research: '#6366f1',
};

const DEFAULT_COLOR = '#06b6d4';

interface ExpertAvatarProps {
  domain: string | null;
  name: string;
  sessionState: VoiceSessionState;
}

export default function ExpertAvatar({ domain, name, sessionState }: ExpertAvatarProps) {
  const color = (domain && DOMAIN_COLORS[domain.toLowerCase()]) || DEFAULT_COLOR;

  const animClass =
    sessionState === 'speaking'
      ? 'animate-avatar-speaking'
      : sessionState === 'listening'
        ? 'animate-avatar-listening'
        : '';

  return (
    <div className="flex flex-col items-center gap-4">
      {/* Glow ring container */}
      <div
        className={`relative w-40 h-40 rounded-full flex items-center justify-center ${animClass}`}
        style={{
          background: `radial-gradient(circle, rgba(13,13,16,0.95) 60%, transparent 100%)`,
          border: `3px solid ${color}`,
          boxShadow: `0 0 30px ${color}50, 0 0 60px ${color}20, inset 0 0 30px ${color}10`,
        }}
      >
        <Bot size={56} style={{ color }} />
      </div>

      {/* Name and status */}
      <div className="text-center">
        <h2 className="text-lg font-semibold text-text-primary">{name}</h2>
        {domain && (
          <span
            className="text-xs font-medium px-2 py-0.5 rounded-full mt-1 inline-block"
            style={{
              color,
              backgroundColor: `${color}15`,
              border: `1px solid ${color}30`,
            }}
          >
            {domain.charAt(0).toUpperCase() + domain.slice(1)}
          </span>
        )}
      </div>
    </div>
  );
}
