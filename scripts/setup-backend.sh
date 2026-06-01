#!/usr/bin/env bash
# Set up the Python backend environment for Cerebro.
#   npm run setup                      — create venv (if needed) + install requirements
#   bash scripts/setup-backend.sh --if-missing
#                                      — fast guard used by `prestart`: no-op when the
#                                        venv already exists and can import uvicorn
#
# On Windows (MINGW/MSYS/Cygwin) this prints the manual command and exits 0, since the
# venv layout and python invocation differ; do the steps by hand there.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKEND_DIR="$PROJECT_ROOT/backend"
VENV_DIR="$BACKEND_DIR/venv"
VENV_PYTHON="$VENV_DIR/bin/python"
REQUIREMENTS="$BACKEND_DIR/requirements.txt"

IF_MISSING=0
[ "${1:-}" = "--if-missing" ] && IF_MISSING=1

case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
        echo "[backend] Windows detected — set up the venv manually:"
        echo "[backend]   cd backend && python -m venv venv && venv\\Scripts\\python -m pip install -r requirements.txt"
        exit 0
        ;;
esac

# Fast path: if the venv already imports uvicorn, there's nothing to do.
if [ -x "$VENV_PYTHON" ] && "$VENV_PYTHON" -c "import uvicorn" >/dev/null 2>&1; then
    [ "$IF_MISSING" -eq 1 ] && exit 0
    echo "[backend] venv already set up — reinstalling requirements"
else
    if [ "$IF_MISSING" -eq 1 ]; then
        echo "[backend] Python environment missing or incomplete — bootstrapping..."
    fi
fi

if [ ! -x "$VENV_PYTHON" ]; then
    echo "[backend] Creating virtualenv at $VENV_DIR"
    python3 -m venv "$VENV_DIR"
fi

echo "[backend] Installing dependencies from requirements.txt"
"$VENV_PYTHON" -m pip install --upgrade pip
"$VENV_PYTHON" -m pip install -r "$REQUIREMENTS"

echo "[backend] Backend environment ready."
