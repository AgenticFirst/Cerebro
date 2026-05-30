/**
 * Module-level config injected once at startup by the Electron main process,
 * so deeply-nested Codex callers (single-shot routine actions, session store)
 * don't have to thread the data dir / backend port through their context.
 * Mirrors `setClaudeCodeCwd` in src/claude-code/single-shot.ts.
 */

let defaultCwd: string | null = null;
let backendPort: number | null = null;

export function setCodexCwd(cwd: string): void {
  defaultCwd = cwd;
}

export function getCodexCwd(): string | null {
  return defaultCwd;
}

export function setCodexBackendPort(port: number): void {
  backendPort = port;
}

export function getCodexBackendPort(): number | null {
  return backendPort;
}
