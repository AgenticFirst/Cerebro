/**
 * Handle type → color mapping for visually distinct edges.
 * V1: no type enforcement, colors are purely visual.
 */

export type HandleType = 'message' | 'data' | 'category' | 'signal';

export const HANDLE_COLORS: Record<HandleType, string> = {
  message: '#8b5cf6',   // Violet — Ask AI, Run Expert, Summarize
  data: '#f59e0b',      // Amber — Extract, HTTP Request, Search, integrations
  category: '#6366f1',  // Indigo — Classify
  signal: '#64748b',    // Slate — Condition, Loop, Delay, Approval, triggers
};

/** Determine the output handle type for a given action type. */
export function getHandleType(actionType: string): HandleType {
  switch (actionType) {
    case 'ask_ai':
    case 'run_expert':
    case 'summarize':
    case 'run_claude_code':
    case 'model_call':   // legacy
    case 'expert_step':  // legacy
      return 'message';

    case 'extract':
    case 'http_request':
    case 'search_memory':
    case 'search_web':
    case 'search_documents':
    case 'save_to_memory':
    case 'run_command':
    case 'run_script':
    case 'connector':    // legacy
      return 'data';

    case 'classify':
      return 'category';

    default:
      return 'signal';
  }
}

/** Get the edge color for a source action type. */
export function getEdgeColor(sourceActionType: string): string {
  return HANDLE_COLORS[getHandleType(sourceActionType)];
}
