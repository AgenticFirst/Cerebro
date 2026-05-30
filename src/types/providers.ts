// Cerebro runs inference through pluggable coding-agent CLIs (Claude Code,
// Codex). The engine-neutral availability shape lives in src/engines/types.ts;
// these aliases preserve the historical `ClaudeCode*` names used across the UI.

import type { EngineInfo, EngineStatus } from '../engines/types';

export type ClaudeCodeStatus = EngineStatus;
export type ClaudeCodeInfo = EngineInfo;
