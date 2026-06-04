import type { ReactNode } from 'react';
import clsx from 'clsx';
import { Check } from 'lucide-react';

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  className?: string;
}

/** Branded checkbox (neural theme) — replaces native <input type="checkbox">. */
export default function Checkbox({
  checked,
  onChange,
  label,
  disabled = false,
  className,
}: CheckboxProps) {
  return (
    <label
      className={clsx(
        'inline-flex items-center gap-2 select-none',
        disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
        className,
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={clsx(
          'w-4 h-4 rounded-[5px] flex items-center justify-center border transition-colors flex-shrink-0',
          checked
            ? 'bg-accent border-accent text-black'
            : 'bg-bg-surface border-border-default hover:border-accent/60',
        )}
      >
        {checked && <Check size={11} strokeWidth={3} />}
      </button>
      {label != null && <span className="text-[12px] text-text-secondary">{label}</span>}
    </label>
  );
}
