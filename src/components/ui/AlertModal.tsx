/**
 * Reusable alert/info modal matching the neural design system.
 * Follows the same pattern as ApiKeyAlert in ModelsSection.
 */

import { X } from 'lucide-react';
import type { ReactNode } from 'react';

interface AlertAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

interface AlertModalProps {
  icon?: ReactNode;
  title: string;
  message: string;
  actions?: AlertAction[];
  onClose: () => void;
}

export default function AlertModal({ icon, title, message, actions, onClose }: AlertModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Dialog */}
      <div className="relative bg-bg-surface border border-border-subtle rounded-xl shadow-2xl w-full max-w-sm mx-4 animate-fade-in">
        <div className="px-5 pt-5 pb-4">
          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute top-3 right-3 p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
          >
            <X size={14} />
          </button>

          <div className="flex items-center gap-3 mb-3">
            {icon && (
              <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0">
                {icon}
              </div>
            )}
            <h3 className="text-sm font-medium text-text-primary">{title}</h3>
          </div>
          <p className="text-xs text-text-secondary leading-relaxed">{message}</p>
        </div>
        <div className="border-t border-border-subtle px-5 py-3 flex justify-end gap-2">
          {actions && actions.length > 0 ? (
            actions.map((action) => (
              <button
                key={action.label}
                onClick={action.onClick}
                className={
                  action.primary
                    ? 'px-4 py-1.5 rounded-md text-xs font-medium bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors cursor-pointer'
                    : 'px-4 py-1.5 rounded-md text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer'
                }
              >
                {action.label}
              </button>
            ))
          ) : (
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-md text-xs font-medium bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors cursor-pointer"
            >
              Got it
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
