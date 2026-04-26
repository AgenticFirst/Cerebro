import { useRef } from 'react';
import { BadgeCheck, Bot } from 'lucide-react';
import type { VoiceSessionState } from '../../../voice/types';
import { getAvatar } from '../../../constants/avatars';
import { useAmplitudePulse } from '../../../hooks/useAmplitudePulse';

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
  avatarUrl: string | null;
  analyser: AnalyserNode | null;
  isVerified?: boolean;
}

export default function ExpertAvatar({ domain, name, sessionState, avatarUrl, analyser, isVerified }: ExpertAvatarProps) {
  const color = (domain && DOMAIN_COLORS[domain.toLowerCase()]) || DEFAULT_COLOR;
  const avatar = getAvatar(avatarUrl);
  const pulseRef = useRef<HTMLDivElement>(null);

  const pulseActive = sessionState === 'speaking' ? analyser : null;
  useAmplitudePulse(pulseActive, pulseRef, 0.12);

  const animClass =
    sessionState === 'speaking'
      ? 'animate-avatar-speaking'
      : sessionState === 'listening'
        ? 'animate-avatar-listening'
        : '';

  return (
    <div className="flex flex-col items-center gap-4">
      <div
        className={`relative w-40 h-40 rounded-full flex items-center justify-center ${animClass}`}
        style={{
          background: `radial-gradient(circle, rgba(13,13,16,0.95) 60%, transparent 100%)`,
          border: `3px solid ${color}`,
          boxShadow: `0 0 30px ${color}50, 0 0 60px ${color}20, inset 0 0 30px ${color}10`,
        }}
      >
        <div
          ref={pulseRef}
          className="flex items-center justify-center transition-transform duration-75 ease-out will-change-transform"
        >
          {avatar ? (
            <span
              className="twemoji leading-none pointer-events-none select-none"
              style={{ fontSize: 96 }}
              aria-label={avatar.label}
            >
              {avatar.emoji}
            </span>
          ) : (
            <Bot size={56} style={{ color }} />
          )}
        </div>
        {isVerified && (
          <BadgeCheck
            size={28}
            className="absolute bottom-2 right-2 text-accent fill-bg-primary"
            strokeWidth={2.25}
          />
        )}
      </div>

      <div className="text-center">
        <h2 className="flex items-center justify-center gap-1.5 text-lg font-semibold text-text-primary">
          {name}
          {isVerified && <BadgeCheck size={16} className="text-accent" strokeWidth={2.25} />}
        </h2>
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
