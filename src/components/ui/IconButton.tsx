import { type ReactNode, type ButtonHTMLAttributes } from 'react';
import clsx from 'clsx';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
}

export default function IconButton({ icon, className, ...props }: IconButtonProps) {
  return (
    <button
      className={clsx(
        'flex items-center justify-center rounded-lg p-2',
        'text-text-secondary hover:text-text-primary',
        'hover:bg-bg-hover transition-colors duration-150',
        'disabled:opacity-40 disabled:pointer-events-none',
        className,
      )}
      {...props}
    >
      {icon}
    </button>
  );
}
