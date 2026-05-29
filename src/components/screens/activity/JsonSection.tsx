import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import clsx from 'clsx';

interface JsonSectionProps {
  label: string;
  json: string | null;
  defaultOpen?: boolean;
}

export default function JsonSection({ label, json, defaultOpen = false }: JsonSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  if (!json) return null;

  let formatted: string;
  try {
    formatted = JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    formatted = json;
  }

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-[10px] font-medium text-text-tertiary hover:text-text-secondary transition-colors"
      >
        <ChevronRight
          size={10}
          className={clsx('transition-transform duration-150', open && 'rotate-90')}
        />
        {label}
      </button>
      {open && (
        <pre className="bg-bg-base rounded-md px-2.5 py-2 font-mono text-[10px] text-text-secondary mt-1 max-h-[200px] overflow-auto scrollbar-thin whitespace-pre-wrap break-all">
          {formatted}
        </pre>
      )}
    </div>
  );
}
