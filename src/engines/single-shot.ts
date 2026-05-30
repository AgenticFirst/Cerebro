/**
 * Engine-aware single-shot inference for routine-engine steps.
 *
 * Routine steps have no conversation, so they use the GLOBAL active engine
 * (`selected_engine`). When that's Codex (and Codex is registered) we run Codex;
 * otherwise — including before engines are registered, e.g. in unit tests —
 * we fall back to `singleShotClaudeCode`, which is also the path those tests
 * mock. This keeps existing engine-action tests green while making routine
 * inference follow the user's engine choice.
 */

import { resolveActiveEngineId, tryGetEngine } from './registry';
import { singleShotClaudeCode } from '../claude-code/single-shot';
import type { SingleShotEngineOptions } from './types';

export async function singleShotActiveEngine(opts: SingleShotEngineOptions): Promise<string> {
  let id: string;
  try {
    id = await resolveActiveEngineId();
  } catch {
    id = 'claude-code';
  }
  if (id === 'codex') {
    const codex = tryGetEngine('codex');
    if (codex) return codex.singleShot(opts);
  }
  return singleShotClaudeCode(opts);
}
