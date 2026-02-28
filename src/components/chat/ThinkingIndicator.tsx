import { useState, useEffect } from 'react';
import { Brain, Cpu, Sparkles, Search, Lightbulb, Workflow, Zap } from 'lucide-react';

const THINKING_ICONS = [Brain, Cpu, Sparkles, Search, Lightbulb, Workflow, Zap];
const CYCLE_MS = 500;

export default function ThinkingIndicator() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setIndex((i) => (i + 1) % THINKING_ICONS.length);
    }, CYCLE_MS);
    return () => clearInterval(interval);
  }, []);

  const Icon = THINKING_ICONS[index];

  return (
    <div className="animate-fade-in flex items-center gap-2.5 py-2 px-1">
      <div className="relative flex items-center justify-center w-5 h-5 text-accent">
        <Icon size={16} className="transition-opacity duration-150" />
      </div>
      <span className="text-xs text-text-secondary">
        Cerebro is thinking<span className="thinking-dots" />
      </span>
    </div>
  );
}
