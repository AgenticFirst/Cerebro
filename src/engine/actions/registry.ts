/**
 * ActionRegistry — maps action type strings to their definitions.
 *
 * Populated at engine initialization. Rejects duplicate registrations.
 */

import type { ActionDefinition } from './types';

// ── ActionRegistry ──────────────────────────────────────────────

export class ActionRegistry {
  private actions = new Map<string, ActionDefinition>();

  register(action: ActionDefinition): void {
    if (this.actions.has(action.type)) {
      throw new Error(`Action type "${action.type}" already registered`);
    }
    this.actions.set(action.type, action);
  }

  get(type: string): ActionDefinition | undefined {
    return this.actions.get(type);
  }

  has(type: string): boolean {
    return this.actions.has(type);
  }

  list(): ActionDefinition[] {
    return Array.from(this.actions.values());
  }
}
