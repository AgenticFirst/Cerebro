/**
 * Action type metadata, categories, and default step parameters.
 *
 * See docs/tech-designs/actions.md for the full taxonomy.
 */

import {
  Zap,
  Brain,
  BookOpen,
  Plug2,
  GitBranch,
  ArrowUpRight,
  MessageSquare,
  Bot,
  Tags,
  FileOutput,
  FileText,
  Search,
  Globe,
  FileSearch,
  Save,
  Globe2,
  Calendar,
  Mail,
  MessageCircle,
  Activity,
  Github,
  StickyNote,
  Shuffle,
  Timer,
  ShieldCheck,
  Merge,
  Send,
  Bell,
  Reply,
  Terminal,
  Webhook,
  FileCode,
  type LucideIcon,
} from 'lucide-react';
import type { RoutineStepData } from './dag-flow-mapping';
import { DEFAULT_CLAUDE_MODEL } from './claude-models';

// ── Action Categories ─────────────────────────────────────────

export type ActionCategoryId =
  | 'triggers'
  | 'ai'
  | 'knowledge'
  | 'integrations'
  | 'logic'
  | 'output';

export interface ActionCategory {
  id: ActionCategoryId;
  name: string;
  icon: LucideIcon;
  color: string;        // Tailwind color class prefix
  colorHex: string;     // Hex for canvas rendering
}

export const TRIGGER_TEAL = '#14b8a6';

export const ACTION_CATEGORIES: ActionCategory[] = [
  { id: 'triggers',     name: 'Triggers',     icon: Zap,          color: 'teal',    colorHex: TRIGGER_TEAL },
  { id: 'ai',           name: 'AI',           icon: Brain,        color: 'violet',  colorHex: '#8b5cf6' },
  { id: 'knowledge',    name: 'Knowledge',    icon: BookOpen,     color: 'indigo',  colorHex: '#6366f1' },
  { id: 'integrations', name: 'Integrations', icon: Plug2,        color: 'blue',    colorHex: '#3b82f6' },
  { id: 'logic',        name: 'Logic',        icon: GitBranch,    color: 'slate',   colorHex: '#64748b' },
  { id: 'output',       name: 'Output',       icon: ArrowUpRight, color: 'emerald', colorHex: '#10b981' },
];

export const CATEGORY_MAP = Object.fromEntries(
  ACTION_CATEGORIES.map((c) => [c.id, c]),
) as Record<ActionCategoryId, ActionCategory>;

// ── Action Metadata ───────────────────────────────────────────

export interface ActionMeta {
  name: string;
  icon: LucideIcon;
  color: string;        // Tailwind color class prefix
  colorHex: string;     // Hex for canvas rendering
  description: string;
  category: ActionCategoryId;
  isAvailable: boolean; // false = shows "soon" badge, not draggable
  keywords: string[];   // for sidebar search
}

export const ACTION_META: Record<string, ActionMeta> = {
  // ── Triggers ──────────────────────────────────────────────
  trigger_schedule: {
    name: 'Schedule',
    icon: Zap,
    color: 'teal',
    colorHex: TRIGGER_TEAL,
    description: 'Run on a cron schedule',
    category: 'triggers',
    isAvailable: true,
    keywords: ['cron', 'time', 'recurring', 'timer'],
  },
  trigger_manual: {
    name: 'Manual',
    icon: Zap,
    color: 'teal',
    colorHex: TRIGGER_TEAL,
    description: 'Run with a button click',
    category: 'triggers',
    isAvailable: true,
    keywords: ['button', 'click', 'run'],
  },
  trigger_webhook: {
    name: 'Webhook',
    icon: Zap,
    color: 'teal',
    colorHex: TRIGGER_TEAL,
    description: 'Run when HTTP POST arrives',
    category: 'triggers',
    isAvailable: true,
    keywords: ['http', 'post', 'api', 'endpoint'],
  },
  trigger_app_event: {
    name: 'App Event',
    icon: Zap,
    color: 'teal',
    colorHex: TRIGGER_TEAL,
    description: 'Run on external app event',
    category: 'triggers',
    isAvailable: false,
    keywords: ['event', 'app', 'external', 'trigger'],
  },

  // ── AI ────────────────────────────────────────────────────
  ask_ai: {
    name: 'Ask AI',
    icon: MessageSquare,
    color: 'violet',
    colorHex: '#8b5cf6',
    description: 'Single LLM prompt',
    category: 'ai',
    isAvailable: true,
    keywords: ['llm', 'prompt', 'chat', 'model', 'gpt', 'claude'],
  },
  run_expert: {
    name: 'Run Expert',
    icon: Bot,
    color: 'violet',
    colorHex: '#8b5cf6',
    description: 'Delegate to a Cerebro Expert for multi-turn work',
    category: 'ai',
    isAvailable: true,
    keywords: ['agent', 'expert', 'delegate', 'multi-turn'],
  },
  classify: {
    name: 'Classify',
    icon: Tags,
    color: 'violet',
    colorHex: '#8b5cf6',
    description: 'Categorize input with AI',
    category: 'ai',
    isAvailable: true,
    keywords: ['categorize', 'label', 'sort', 'triage'],
  },
  extract: {
    name: 'Extract',
    icon: FileOutput,
    color: 'violet',
    colorHex: '#8b5cf6',
    description: 'Pull structured data from unstructured text',
    category: 'ai',
    isAvailable: true,
    keywords: ['parse', 'structured', 'json', 'fields', 'schema'],
  },
  summarize: {
    name: 'Summarize',
    icon: FileText,
    color: 'violet',
    colorHex: '#8b5cf6',
    description: 'Condense long text',
    category: 'ai',
    isAvailable: true,
    keywords: ['summary', 'condense', 'brief', 'shorten'],
  },

  // ── Knowledge ─────────────────────────────────────────────
  search_memory: {
    name: 'Search Memory',
    icon: Search,
    color: 'indigo',
    colorHex: '#6366f1',
    description: "Look things up in an expert's memory",
    category: 'knowledge',
    isAvailable: true,
    keywords: ['memory', 'recall', 'facts', 'notes', 'expert'],
  },
  search_web: {
    name: 'Search Web',
    icon: Globe,
    color: 'indigo',
    colorHex: '#6366f1',
    description: 'Web search via Claude Code',
    category: 'knowledge',
    isAvailable: true,
    keywords: ['web', 'search', 'internet', 'google', 'claude'],
  },
  search_documents: {
    name: 'Search Documents',
    icon: FileSearch,
    color: 'indigo',
    colorHex: '#6366f1',
    description: 'Ask a question against a Files bucket',
    category: 'knowledge',
    isAvailable: true,
    keywords: ['rag', 'documents', 'files', 'bucket', 'folder'],
  },
  save_to_memory: {
    name: 'Save to Memory',
    icon: Save,
    color: 'indigo',
    colorHex: '#6366f1',
    description: 'Append to expert or global memory',
    category: 'knowledge',
    isAvailable: true,
    keywords: ['save', 'store', 'remember', 'persist', 'memory'],
  },

  // ── Integrations ──────────────────────────────────────────
  http_request: {
    name: 'HTTP Request',
    icon: Globe2,
    color: 'blue',
    colorHex: '#3b82f6',
    description: 'Call any REST API',
    category: 'integrations',
    isAvailable: true,
    keywords: ['api', 'rest', 'fetch', 'curl', 'request', 'http'],
  },
  integration_google_calendar: {
    name: 'Google Calendar',
    icon: Calendar,
    color: 'blue',
    colorHex: '#3b82f6',
    description: 'Get/create events',
    category: 'integrations',
    isAvailable: false,
    keywords: ['calendar', 'google', 'events', 'schedule'],
  },
  integration_gmail: {
    name: 'Gmail',
    icon: Mail,
    color: 'blue',
    colorHex: '#3b82f6',
    description: 'Read/send emails',
    category: 'integrations',
    isAvailable: false,
    keywords: ['email', 'gmail', 'google', 'mail'],
  },
  integration_slack: {
    name: 'Slack',
    icon: MessageCircle,
    color: 'blue',
    colorHex: '#3b82f6',
    description: 'Send/read messages',
    category: 'integrations',
    isAvailable: false,
    keywords: ['slack', 'chat', 'channel', 'message'],
  },
  integration_whatsapp: {
    name: 'WhatsApp',
    icon: MessageCircle,
    color: 'blue',
    colorHex: '#3b82f6',
    description: 'Send messages',
    category: 'integrations',
    isAvailable: false,
    keywords: ['whatsapp', 'message', 'phone', 'text'],
  },
  integration_strava: {
    name: 'Strava',
    icon: Activity,
    color: 'blue',
    colorHex: '#3b82f6',
    description: 'Get activities/stats',
    category: 'integrations',
    isAvailable: false,
    keywords: ['strava', 'running', 'cycling', 'fitness', 'activity'],
  },
  integration_github: {
    name: 'GitHub',
    icon: Github,
    color: 'blue',
    colorHex: '#3b82f6',
    description: 'Issues, PRs, repos',
    category: 'integrations',
    isAvailable: false,
    keywords: ['github', 'git', 'issues', 'pull requests', 'repos'],
  },
  integration_notion: {
    name: 'Notion',
    icon: StickyNote,
    color: 'blue',
    colorHex: '#3b82f6',
    description: 'Query/create pages',
    category: 'integrations',
    isAvailable: false,
    keywords: ['notion', 'pages', 'database', 'wiki'],
  },
  run_command: {
    name: 'Run Command',
    icon: Terminal,
    color: 'blue',
    colorHex: '#3b82f6',
    description: 'Execute a shell command',
    category: 'integrations',
    isAvailable: true,
    keywords: ['shell', 'command', 'terminal', 'exec', 'bash', 'cli'],
  },
  run_claude_code: {
    name: 'Claude Code',
    icon: Bot,
    color: 'blue',
    colorHex: '#3b82f6',
    description: 'Run Claude Code CLI',
    category: 'integrations',
    isAvailable: true,
    keywords: ['claude', 'code', 'ai', 'implement', 'review', 'plan'],
  },

  // ── Logic ─────────────────────────────────────────────────
  condition: {
    name: 'Condition',
    icon: GitBranch,
    color: 'slate',
    colorHex: '#64748b',
    description: 'If/else branching',
    category: 'logic',
    isAvailable: true,
    keywords: ['if', 'else', 'branch', 'condition', 'switch'],
  },
  loop: {
    name: 'Loop',
    icon: Shuffle,
    color: 'slate',
    colorHex: '#64748b',
    description: 'Iterate over items',
    category: 'logic',
    isAvailable: true,
    keywords: ['loop', 'iterate', 'foreach', 'repeat', 'list'],
  },
  delay: {
    name: 'Delay',
    icon: Timer,
    color: 'slate',
    colorHex: '#64748b',
    description: 'Wait before continuing',
    category: 'logic',
    isAvailable: true,
    keywords: ['wait', 'delay', 'pause', 'timer', 'sleep'],
  },
  approval_gate: {
    name: 'Approval Gate',
    icon: ShieldCheck,
    color: 'slate',
    colorHex: '#64748b',
    description: 'Pause for human review',
    category: 'logic',
    isAvailable: true,
    keywords: ['approval', 'review', 'gate', 'human', 'confirm'],
  },
  wait_for_webhook: {
    name: 'Wait for Webhook',
    icon: Webhook,
    color: 'slate',
    colorHex: '#64748b',
    description: 'Pause until HTTP callback arrives',
    category: 'logic',
    isAvailable: true,
    keywords: ['webhook', 'wait', 'callback', 'external', 'http'],
  },
  run_script: {
    name: 'Run Script',
    icon: FileCode,
    color: 'slate',
    colorHex: '#64748b',
    description: 'Execute Python or JavaScript code',
    category: 'logic',
    isAvailable: true,
    keywords: ['script', 'python', 'javascript', 'code', 'eval'],
  },
  merge: {
    name: 'Merge',
    icon: Merge,
    color: 'slate',
    colorHex: '#64748b',
    description: 'Combine parallel branches',
    category: 'logic',
    isAvailable: false,
    keywords: ['merge', 'combine', 'join', 'parallel'],
  },

  // ── Output ────────────────────────────────────────────────
  send_message: {
    name: 'Send Message',
    icon: Send,
    color: 'emerald',
    colorHex: '#10b981',
    description: 'Post to Cerebro chat',
    category: 'output',
    isAvailable: true,
    keywords: ['message', 'chat', 'send', 'post', 'notify'],
  },
  send_notification: {
    name: 'Notification',
    icon: Bell,
    color: 'emerald',
    colorHex: '#10b981',
    description: 'Desktop notification',
    category: 'output',
    isAvailable: true,
    keywords: ['notification', 'alert', 'desktop', 'push'],
  },
  send_email: {
    name: 'Send Email',
    icon: Mail,
    color: 'emerald',
    colorHex: '#10b981',
    description: 'Email via provider',
    category: 'output',
    isAvailable: false,
    keywords: ['email', 'send', 'mail', 'smtp'],
  },
  webhook_response: {
    name: 'Webhook Response',
    icon: Reply,
    color: 'emerald',
    colorHex: '#10b981',
    description: 'Reply to webhook caller',
    category: 'output',
    isAvailable: false,
    keywords: ['webhook', 'response', 'reply', 'http'],
  },
};

export const ACTION_TYPES = Object.keys(ACTION_META);

// ── Old → New Action Type Migration ─────────────────────────

/** Maps legacy action type names to their new equivalents. */
export const ACTION_TYPE_MIGRATION: Record<string, string> = {
  model_call: 'ask_ai',
  expert_step: 'run_expert',
  transformer: 'condition', // closest logic equivalent
  connector: 'http_request',
  channel: 'send_message',
};

/** Resolves an action type, applying migration if needed. */
export function resolveActionType(actionType: string): string {
  return ACTION_TYPE_MIGRATION[actionType] ?? actionType;
}

// ── Helpers ─────────────────────────────────────────────────

/** Get actions grouped by category. */
export function getActionsByCategory(): { category: ActionCategory; actions: [string, ActionMeta][] }[] {
  return ACTION_CATEGORIES.map((category) => ({
    category,
    actions: Object.entries(ACTION_META).filter(
      ([, meta]) => meta.category === category.id,
    ),
  }));
}

/** Check if an action type is a trigger. */
export function isTriggerAction(actionType: string): boolean {
  return ACTION_META[actionType]?.category === 'triggers';
}

// ── Default Step Data ─────────────────────────────────────────

export function getDefaultStepData(
  actionType: string,
): Pick<RoutineStepData, 'params' | 'requiresApproval' | 'onError'> {
  const base = {
    requiresApproval: false,
    onError: 'fail' as const,
  };

  switch (actionType) {
    // AI
    case 'ask_ai':
    case 'model_call': // legacy
      return { ...base, params: { prompt: '', system_prompt: '', agent: 'cerebro', model: DEFAULT_CLAUDE_MODEL } };
    case 'run_expert':
    case 'expert_step': // legacy
      return { ...base, params: { expertId: '', prompt: '', additionalContext: '', maxTurns: 10, model: DEFAULT_CLAUDE_MODEL } };
    case 'classify':
      return { ...base, params: { prompt: '', categories: [], agent: 'cerebro', model: DEFAULT_CLAUDE_MODEL } };
    case 'extract':
      return { ...base, params: { prompt: '', schema: [], agent: 'cerebro', model: DEFAULT_CLAUDE_MODEL } };
    case 'summarize':
      return { ...base, params: { input_field: '', max_length: 'medium', focus: '', agent: 'cerebro', model: DEFAULT_CLAUDE_MODEL } };

    // Knowledge
    case 'search_memory':
      return {
        ...base,
        params: {
          query: '',
          agent: 'cerebro',
          max_results: 5,
          model: DEFAULT_CLAUDE_MODEL,
        },
      };
    case 'search_web':
      return {
        ...base,
        params: {
          query: '',
          max_results: 5,
          include_ai_answer: false,
          model: 'claude-haiku-4-5',
        },
      };
    case 'search_documents':
      return {
        ...base,
        params: {
          query: '',
          bucket_id: '',
          max_results: 5,
          model: DEFAULT_CLAUDE_MODEL,
        },
      };
    case 'save_to_memory':
      return {
        ...base,
        params: {
          content: '',
          agent: 'cerebro',
          mode: 'write',
          topic: '',
          model: DEFAULT_CLAUDE_MODEL,
        },
      };

    // Integrations
    case 'http_request':
    case 'connector': // legacy
      return { ...base, params: { method: 'GET', url: '', headers: [], body: '', auth_type: 'none', auth_value: '', auth_header: '', timeout: 30 } };

    // Integrations (process)
    case 'run_command':
      return { ...base, params: { command: '', args: '', working_directory: '', timeout: 300 } };
    case 'run_claude_code':
      return { ...base, params: { mode: 'ask', prompt: '', working_directory: '', max_turns: 50, timeout: 600 } };

    // Logic
    case 'condition':
      return { ...base, params: { field: '', operator: 'equals', value: '' } };
    case 'loop':
      return { ...base, params: { items_field: '', variable_name: 'item' } };
    case 'delay':
      return { ...base, params: { duration: 1, unit: 'seconds' } };
    case 'approval_gate':
      return { requiresApproval: true, onError: 'fail' as const, params: { summary: '' } };
    case 'wait_for_webhook':
      return { ...base, params: { match_path: '', timeout: 3600, description: '' } };
    case 'run_script':
      return { ...base, params: { language: 'python', code: '', timeout: 30 } };
    case 'merge':
      return { ...base, params: { strategy: 'combine_all', match_field: '' } };

    // Output
    case 'send_message':
    case 'channel': // legacy
      return { ...base, params: { message: '', target: 'cerebro_chat' } };
    case 'send_notification':
      return { ...base, params: { title: '', body: '', urgency: 'normal' } };
    case 'send_email':
      return { ...base, params: { to: '', subject: '', body: '', provider: '' } };
    case 'webhook_response':
      return { ...base, params: { status_code: 200, body: '', headers: [] } };

    // Legacy
    case 'transformer':
      return { ...base, params: { operation: 'format', template: '' } };

    default:
      return { ...base, params: {} };
  }
}
