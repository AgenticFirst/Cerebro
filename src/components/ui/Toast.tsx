import { XCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useToast } from '../../context/ToastContext';
import type { ToastType } from '../../context/ToastContext';

const ICON_MAP: Record<ToastType, typeof XCircle> = {
  error: XCircle,
  success: CheckCircle2,
  info: Info,
};

const BORDER_COLOR: Record<ToastType, string> = {
  error: 'border-l-red-500',
  success: 'border-l-green-500',
  info: 'border-l-accent',
};

const ICON_COLOR: Record<ToastType, string> = {
  error: 'text-red-400',
  success: 'text-green-400',
  info: 'text-accent',
};

export default function ToastContainer() {
  const { toasts, dismissToast } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((toast) => {
        const Icon = ICON_MAP[toast.type];
        return (
          <div
            key={toast.id}
            className={`animate-slide-up flex items-center gap-2.5 px-4 py-3 bg-bg-elevated border border-border-subtle border-l-[3px] ${BORDER_COLOR[toast.type]} rounded-lg shadow-lg max-w-sm`}
          >
            <Icon size={16} className={`flex-shrink-0 ${ICON_COLOR[toast.type]}`} />
            <span className="text-xs text-text-primary flex-1">{toast.message}</span>
            {toast.action && (
              <button
                onClick={() => {
                  toast.action!.onClick();
                  dismissToast(toast.id);
                }}
                className={`text-xs font-medium px-2 py-1 rounded hover:bg-bg-subtle transition-colors flex-shrink-0 ${ICON_COLOR[toast.type]}`}
              >
                {toast.action.label}
              </button>
            )}
            <button
              onClick={() => dismissToast(toast.id)}
              className="p-0.5 rounded text-text-tertiary hover:text-text-secondary transition-colors flex-shrink-0"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
