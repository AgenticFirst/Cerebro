import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { ACTION_META, ACTION_TYPES } from '../../../utils/step-defaults';

/** Action types that have a working execution handler. */
const AVAILABLE_TYPES = ACTION_TYPES.filter((t) => t !== 'connector' && t !== 'channel');

export default function NodePalette() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="absolute bottom-4 left-4 z-20">
      {isOpen ? (
        <div className="bg-bg-surface border border-border-subtle rounded-lg shadow-lg overflow-hidden w-[180px] animate-fade-in">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
              Actions
            </span>
            <button
              onClick={() => setIsOpen(false)}
              className="p-0.5 rounded text-text-tertiary hover:text-text-secondary transition-colors"
            >
              <X size={12} />
            </button>
          </div>

          <div className="py-1">
            {AVAILABLE_TYPES.map((type) => {
              const meta = ACTION_META[type];
              const Icon = meta.icon;
              return (
                <div
                  key={type}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/cerebro-action-type', type);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  className="flex items-center gap-2.5 px-3 py-2 cursor-grab active:cursor-grabbing hover:bg-bg-hover transition-colors"
                >
                  <div
                    className="w-6 h-6 rounded flex items-center justify-center flex-shrink-0"
                    style={{ backgroundColor: `${meta.colorHex}20` }}
                  >
                    <Icon size={13} style={{ color: meta.colorHex }} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-text-primary truncate">
                      {meta.name}
                    </div>
                    <div className="text-[10px] text-text-tertiary truncate">
                      {meta.description}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <button
          onClick={() => setIsOpen(true)}
          className="w-9 h-9 rounded-lg bg-bg-surface border border-border-subtle flex items-center justify-center text-text-tertiary hover:text-accent hover:border-accent/30 transition-colors shadow-lg"
          aria-label="Add action"
        >
          <Plus size={18} />
        </button>
      )}
    </div>
  );
}
