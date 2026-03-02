/**
 * Horizontal row of expert pills above the chat input.
 * Click to select which expert handles the next message.
 */

import { useEffect } from 'react';
import { Bot } from 'lucide-react';
import clsx from 'clsx';
import { useExperts } from '../../context/ExpertContext';
import { useChat } from '../../context/ChatContext';

export default function ExpertTray() {
  const { experts, loadExperts } = useExperts();
  const { activeExpertId, setActiveExpertId } = useChat();

  useEffect(() => {
    loadExperts();
  }, [loadExperts]);

  const enabledExperts = experts.filter((e) => e.isEnabled && e.type === 'expert');

  // Don't show if no experts exist
  if (enabledExperts.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 px-1 overflow-x-auto scrollbar-none">
      {/* Cerebro pill (default / no expert) */}
      <button
        onClick={() => setActiveExpertId(null)}
        className={clsx(
          'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium',
          'transition-all duration-150 whitespace-nowrap flex-shrink-0',
          activeExpertId === null
            ? 'bg-accent/15 text-accent border border-accent/30'
            : 'bg-bg-elevated text-text-tertiary border border-transparent hover:text-text-secondary hover:bg-bg-hover',
        )}
      >
        <Bot size={12} />
        Cerebro
      </button>

      {/* Expert pills */}
      {enabledExperts.map((expert) => (
        <button
          key={expert.id}
          onClick={() => setActiveExpertId(activeExpertId === expert.id ? null : expert.id)}
          className={clsx(
            'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium',
            'transition-all duration-150 whitespace-nowrap flex-shrink-0',
            activeExpertId === expert.id
              ? 'bg-accent/15 text-accent border border-accent/30'
              : 'bg-bg-elevated text-text-tertiary border border-transparent hover:text-text-secondary hover:bg-bg-hover',
          )}
        >
          <div
            className={clsx(
              'w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold',
              activeExpertId === expert.id ? 'bg-accent text-bg-base' : 'bg-bg-hover text-text-secondary',
            )}
          >
            {expert.name[0]?.toUpperCase()}
          </div>
          {expert.name}
        </button>
      ))}
    </div>
  );
}
