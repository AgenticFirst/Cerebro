import {
  Brain,
  Layout,
  GitMerge,
  Wrench,
  Globe,
  Code,
  PenTool,
  BarChart3,
  ListChecks,
  FileText,
  Zap,
  Search,
  Shield,
  MessageSquare,
  Sparkles,
  Dumbbell,
  HeartPulse,
  Activity,
  Target,
  Apple,
  Scale,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react';

export const ICON_MAP: Record<string, LucideIcon> = {
  brain: Brain,
  layout: Layout,
  'git-merge': GitMerge,
  wrench: Wrench,
  globe: Globe,
  code: Code,
  'pen-tool': PenTool,
  'bar-chart-3': BarChart3,
  'list-checks': ListChecks,
  'file-text': FileText,
  zap: Zap,
  search: Search,
  shield: Shield,
  'message-square': MessageSquare,
  sparkles: Sparkles,
  dumbbell: Dumbbell,
  'heart-pulse': HeartPulse,
  activity: Activity,
  target: Target,
  apple: Apple,
  scale: Scale,
};

interface SkillIconProps extends Omit<LucideProps, 'ref'> {
  name: string | null;
}

export default function SkillIcon({ name, ...props }: SkillIconProps) {
  const Icon = ICON_MAP[name ?? ''] ?? Sparkles;
  return <Icon {...props} />;
}
