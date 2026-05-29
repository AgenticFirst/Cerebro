/**
 * Resolves the directory holding a `python` interpreter that already has
 * Cerebro's backend dependencies installed (python-docx, openpyxl,
 * python-pptx, pypdf, etc. — see backend/requirements.txt).
 *
 * Used by:
 *   - main.ts to spawn the FastAPI backend
 *   - claude-code/stream-adapter.ts to put the same Python on the
 *     subprocess PATH so the agent's Bash tool can `import docx` etc.
 *     without a setup step
 *
 * Packaged: <resourcesPath>/python-dist/bin (relocatable CPython 3.11
 * with deps baked into site-packages — see scripts/bundle-python.sh).
 * Dev:      <appPath>/backend/venv/bin (developer's own venv).
 *
 * Returns null when neither exists; callers fall back gracefully.
 */
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

export function resolveBackendPythonBinDir(): string | null {
  const isWin = process.platform === 'win32';
  const binSubdir = isWin ? 'Scripts' : 'bin';

  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'python-dist', binSubdir);
    if (fs.existsSync(bundled)) return bundled;
  }

  const devVenv = path.join(app.getAppPath(), 'backend', 'venv', binSubdir);
  if (fs.existsSync(devVenv)) return devVenv;

  return null;
}

/**
 * The VIRTUAL_ENV root corresponding to the bin dir above. Setting this on
 * the spawn env makes pip / venv-aware tooling treat the dir as an active
 * virtualenv. For the bundled python-dist (not a venv) we omit it.
 */
export function resolveBackendVirtualEnvRoot(): string | null {
  if (app.isPackaged) return null;
  const venvRoot = path.join(app.getAppPath(), 'backend', 'venv');
  if (fs.existsSync(venvRoot)) return venvRoot;
  return null;
}
