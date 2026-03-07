import { STATUS_CONFIG } from './helpers';

interface StatusDotProps {
  status: string;
  size?: 'sm' | 'md';
}

export default function StatusDot({ status, size = 'sm' }: StatusDotProps) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.created;
  const dim = size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5';
  const containerDim = size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5';

  return (
    <span className={`relative flex-shrink-0 flex items-center justify-center ${containerDim}`}>
      {cfg.glow && (
        <span className={`absolute inset-0 rounded-full ${cfg.dot} animate-pulse-glow`} />
      )}
      <span className={`relative rounded-full ${dim} ${cfg.dot}`} />
    </span>
  );
}
