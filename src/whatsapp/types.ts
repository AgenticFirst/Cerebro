/**
 * WhatsApp (Baileys / WhatsApp Web) types for the Cerebro bridge.
 *
 * Baileys owns its own rich type tree; these are the narrow slices the
 * bridge exposes outward (to IPC, UI, and routine triggers) plus trigger
 * / filter types that mirror the Telegram equivalents.
 */

import type { DAGDefinition } from '../engine/dag/types';

/** Keys for values the bridge persists in the backend `settings` table. */
export const WHATSAPP_SETTING_KEYS = {
  /** Encrypted JSON envelope produced by secure-token.encryptForStorage().
   *  Contains the full Baileys `AuthenticationCreds + SignalKeyStore` snapshot. */
  sessionCreds: 'whatsapp_session_creds',
  /** Array of allowlisted phone numbers (E.164-ish) as strings, or ['*']. */
  allowlist: 'whatsapp_allowlist',
  /** True when the operator has enabled the bridge. */
  enabled: 'whatsapp_enabled',
  /** phone_number → display_name learned from pushName on inbound messages. */
  phoneUsernames: 'whatsapp_phone_usernames',
  /** phone_number → Cerebro conversation id. */
  phoneConversations: 'whatsapp_phone_conversations',
} as const;

export interface WhatsAppSettings {
  allowlist: string[];
  enabled: boolean;
  phoneUsernames: Record<string, string>;
  phoneConversations: Record<string, string>;
}

// Canonical IPC surface types live in src/types/ipc.ts (consistent with how
// TelegramStatusResponse is handled). Re-export for colocated imports.
export type {
  WhatsAppStatusResponse,
  WhatsAppConversationUpdatedEvent,
  WhatsAppAPI,
} from '../types/ipc';

// ── Routine trigger routing ────────────────────────────────────

export type WhatsAppFilterType = 'none' | 'keyword' | 'prefix' | 'regex';

export interface WhatsAppTriggerConfig {
  /** Phone number to match — '*' matches any allowlisted number. */
  phone_number: string;
  filter_type?: WhatsAppFilterType;
  filter_value?: string;
}

export interface WhatsAppTriggerRoutine {
  id: string;
  name: string;
  dag: DAGDefinition;
  trigger: WhatsAppTriggerConfig;
}

/** Loose backend routine record — only the fields we need to parse triggers. */
export interface BackendRoutineRecord {
  id: string;
  name: string;
  is_enabled: boolean;
  trigger_type: string;
  dag_json: string | null;
}

/** The payload we hand to the DAG via the synthetic __trigger__ step. */
export interface WhatsAppTriggerPayload {
  phone_number: string;
  wa_jid: string;
  customer_display_name: string;
  message_text: string;
  message_id: string;
  received_at: string;
  conversation_id: string;
  conversation_history: Array<{ role: 'user' | 'assistant'; content: string }>;
}
