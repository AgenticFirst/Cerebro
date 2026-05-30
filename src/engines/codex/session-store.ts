/**
 * Codex session persistence.
 *
 * Unlike Claude Code (where Cerebro picks a deterministic per-conversation
 * UUID), Codex mints its own session/thread id and reports it in the
 * `thread.started` event. To get multi-turn continuity we capture that id on
 * the first turn and persist it as the settings key `codex_session:<convId>`,
 * then pass it to `codex exec resume <id>` on subsequent turns.
 *
 * Mirrors the existing `claude_session:<convId>` settings pattern — no schema
 * migration. Best-effort: a missing backend port just means no persistence
 * (the run still works, it just won't resume).
 */

import { backendGetSetting, backendPutSetting } from '../../shared/backend-settings';
import { getCodexBackendPort } from './config';

function key(conversationId: string): string {
  return `codex_session:${conversationId}`;
}

export async function getStoredCodexSession(conversationId: string): Promise<string | null> {
  const port = getCodexBackendPort();
  if (port === null) return null;
  try {
    return await backendGetSetting<string>(port, key(conversationId));
  } catch {
    return null;
  }
}

export async function setStoredCodexSession(
  conversationId: string,
  threadId: string,
): Promise<void> {
  const port = getCodexBackendPort();
  if (port === null) return;
  try {
    await backendPutSetting(port, key(conversationId), threadId);
  } catch {
    // best-effort — resume just won't work next turn
  }
}

export async function clearStoredCodexSession(conversationId: string): Promise<void> {
  const port = getCodexBackendPort();
  if (port === null) return;
  try {
    await backendPutSetting(port, key(conversationId), '');
  } catch {
    // ignore
  }
}
