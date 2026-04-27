#!/usr/bin/env bash
# Build the bundled Python runtime for distribution.
#
# Produces two directories under build-resources/ that forge.config.ts
# bundles via packagerConfig.extraResource:
#
#   build-resources/python-dist/  — relocatable CPython 3.11 from
#                                   python-build-standalone, with all
#                                   backend/requirements.txt deps installed
#                                   directly into its site-packages
#   build-resources/backend/      — clean copy of backend/ source (no venv,
#                                   no __pycache__, no tests)
#
# Idempotent: skips python-dist/ rebuild if it already exists and the
# requirements.txt hash hasn't changed.
#
# Requires: uv (https://astral.sh/uv) — install via:
#   curl -LsSf https://astral.sh/uv/install.sh | sh

set -euo pipefail

cd "$(dirname "$0")/.."

OUT_PYTHON="build-resources/python-dist"
OUT_BACKEND="build-resources/backend"
REQ_HASH_FILE="$OUT_PYTHON/.requirements-hash"

if ! command -v uv >/dev/null 2>&1; then
  if [ -x "$HOME/.local/bin/uv" ]; then
    export PATH="$HOME/.local/bin:$PATH"
  else
    echo "[bundle-python] uv not found. Install with:"
    echo "  curl -LsSf https://astral.sh/uv/install.sh | sh"
    exit 1
  fi
fi

# Portable SHA-256 — macOS ships `shasum`, most Linux distros ship `sha256sum`,
# both are present on the GitHub Actions ubuntu-latest runners.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# The cache key includes the OS+arch so switching platforms (e.g. building
# the Linux .deb after a macOS DMG, or vice versa) forces a rebuild instead
# of leaving the wrong-platform .so/.dylib files in build-resources/python-dist/.
PLATFORM_TAG=$(uname -sm | tr ' /' '_-')
REQ_HASH="$(sha256_of backend/requirements.txt)__${PLATFORM_TAG}"

if [ -f "$REQ_HASH_FILE" ] && [ "$(cat "$REQ_HASH_FILE")" = "$REQ_HASH" ]; then
  echo "[bundle-python] python-dist/ up to date (requirements unchanged)"
else
  echo "[bundle-python] (re)building python-dist/..."
  rm -rf "$OUT_PYTHON"
  mkdir -p "$(dirname "$OUT_PYTHON")"

  # Install python-build-standalone CPython via uv. uv stores the
  # extracted distribution at ~/.local/share/uv/python/cpython-X.Y.Z-...
  # The path uv reports may be a symlink (e.g. cpython-3.11-... →
  # cpython-3.11.15-...); resolve to the real path before copying.
  uv python install 3.11
  PY_BIN_PATH=$(uv python find 3.11)
  PY_BIN_REAL=$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$PY_BIN_PATH")
  PY_REAL_DIST_ROOT="$(dirname "$(dirname "$PY_BIN_REAL")")"

  echo "[bundle-python] copying $PY_REAL_DIST_ROOT → $OUT_PYTHON"
  # Use rsync (not `cp -RL`) — the Linux python-build-standalone has
  # many internal symlinks under share/terminfo (`h/hp2621a → 2/2621a`
  # etc). With `cp -L` those symlinks get dereferenced, which produces
  # duplicate target files and `cp` fails with "File exists" partway
  # through. rsync `-a` preserves the relative symlinks correctly.
  # The trailing slashes mean "copy contents of src into dest" so we
  # don't end up with a nested $OUT_PYTHON/<dist-name>/ subdir.
  mkdir -p "$OUT_PYTHON"
  rsync -a "$PY_REAL_DIST_ROOT/" "$OUT_PYTHON/"

  # python-build-standalone marks itself as PEP 668 externally-managed
  # to discourage modifying the system Python. We're bundling our own
  # copy and explicitly want pip to install into it.
  find "$OUT_PYTHON" -name "EXTERNALLY-MANAGED" -delete

  echo "[bundle-python] installing backend/requirements.txt..."
  "$OUT_PYTHON/bin/python3.11" -m pip install --upgrade pip
  "$OUT_PYTHON/bin/python3.11" -m pip install -r backend/requirements.txt

  echo "$REQ_HASH" > "$REQ_HASH_FILE"
  echo "[bundle-python] python-dist size: $(du -sh "$OUT_PYTHON" | cut -f1)"
fi

# Stage a clean backend/ copy without venv, caches, or tests. rsync is
# friendlier than cp for excluding patterns.
echo "[bundle-python] staging backend/ source..."
rm -rf "$OUT_BACKEND"
mkdir -p "$OUT_BACKEND"
rsync -a \
  --exclude 'venv/' \
  --exclude '__pycache__/' \
  --exclude '.pytest_cache/' \
  --exclude 'tests/' \
  --exclude 'conftest.py' \
  --exclude '*.pyc' \
  --exclude '.gitignore' \
  --exclude 'requirements-ci.txt' \
  backend/ "$OUT_BACKEND/"
echo "[bundle-python] backend/ staged: $(du -sh "$OUT_BACKEND" | cut -f1) ($(find "$OUT_BACKEND" -type f | wc -l | tr -d ' ') files)"
echo "[bundle-python] done"
