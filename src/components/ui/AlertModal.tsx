/**
 * Reusable alert/info modal matching the neural design system.
 * Follows the same pattern as ApiKeyAlert in ModelsSection.
 */

import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

interface AlertAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
  variant?: 'default' | 'danger';
}

interface AlertModalProps {
  icon?: ReactNode;
  /** Tints the icon wrapper. Defaults to accent; `danger` tints red to match destructive actions. */
  iconTone?: 'accent' | 'danger';
  title: string;
  message: string;
  actions?: AlertAction[];
  onClose: () => void;
}

export default function AlertModal({ icon, iconTone = 'accent', title, message, actions, onClose }: AlertModalProps) {
  const { t } = useTranslation();
  const iconWrapClass = iconTone === 'danger' ? 'bg-red-500/10' : 'bg-accent/10';
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
              <div className={`w-9 h-9 rounded-lg ${iconWrapClass} flex items-center justify-center flex-shrink-0`}>
                {icon}
              </div>
            )}
            <h3 className="text-sm font-medium text-text-primary">{title}</h3>
          </div>
          <p className="text-xs text-text-secondary leading-relaxed">{message}</p>
        </div>
        <div className="border-t border-border-subtle px-5 py-3 flex justify-end gap-2">
          {actions && actions.length > 0 ? (
            actions.map((action) => {
              let className: string;
              if (action.primary && action.variant === 'danger') {
                className = 'px-4 py-1.5 rounded-md text-xs font-medium bg-red-500 text-white hover:bg-red-600 transition-colors cursor-pointer';
              } else if (action.primary) {
                className = 'px-4 py-1.5 rounded-md text-xs font-medium bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors cursor-pointer';
              } else {
                className = 'px-4 py-1.5 rounded-md text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer';
              }
              return (
                <button
                  key={action.label}
                  onClick={action.onClick}
                  className={className}
                >
                  {action.label}
                </button>
              );
            })
          ) : (
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-md text-xs font-medium bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors cursor-pointer"
            >
              {t('alert.defaultAction')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
