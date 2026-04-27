#!/usr/bin/env bash
# Pre-push build verification.
#
# Runs `electron-forge package` (the same step CI runs before each maker)
# and asserts the produced binary is at the path Linux makers expect.
# Catches binary-naming mismatches before they fail on the GitHub Linux
# runner — which would otherwise eat a 4-minute round-trip per fix.

set -e

cd "$(dirname "$0")/.."

echo "[verify-build] running electron-forge package (SKIP_NOTARIZE=1 — pre-push only verifies the bundle, release workflow handles notarization)…"
# Stream output so the user can see progress; also tee to a log for later inspection.
SKIP_NOTARIZE=1 npx electron-forge package 2>&1 | tee /tmp/cerebro-verify-build.log
# tee always exits 0 — check the package step's status via PIPESTATUS.
if [ "${PIPESTATUS[0]}" -ne 0 ]; then
  echo "[verify-build] package step failed. See /tmp/cerebro-verify-build.log for the full log."
  exit 1
fi

# The packager produces out/<productName>-<platform>-<arch>/. We don't
# care about cross-platform paths here — we only need to verify that, for
# the CURRENT platform, the binary path matches what makers will demand.
PRODUCT_NAME="$(node -p "require('./forge.config.ts.json').packagerConfig?.name || 'Cerebro'" 2>/dev/null || echo Cerebro)"
EXECUTABLE_NAME="$(node -p "require('./package.json').name")"

PLATFORM="$(uname -s)"
case "$PLATFORM" in
  Darwin)
    ARCH="$(uname -m)"
    [ "$ARCH" = "x86_64" ] && ARCH="x64"
    BIN="out/${PRODUCT_NAME}-darwin-${ARCH}/${PRODUCT_NAME}.app/Contents/MacOS/${EXECUTABLE_NAME}"
    ;;
  Linux)
    BIN="out/${PRODUCT_NAME}-linux-x64/${EXECUTABLE_NAME}"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    BIN="out/${PRODUCT_NAME}-win32-x64/${EXECUTABLE_NAME}.exe"
    ;;
  *)
    echo "[verify-build] unsupported platform $PLATFORM — skipping binary path check"
    exit 0
    ;;
esac

if [ ! -f "$BIN" ]; then
  echo "[verify-build] FAIL: expected binary not found at $BIN"
  echo "[verify-build] Forge's deb/rpm/AppImage makers will fail on the Linux runner."
  echo "[verify-build] Fix: set packagerConfig.executableName in forge.config.ts to match package.json.name."
  echo
  echo "[verify-build] What's actually in the packaged dir:"
  find "out" -maxdepth 4 -type f -name "${EXECUTABLE_NAME}*" -o -name "${PRODUCT_NAME}" 2>/dev/null | head -10
  exit 1
fi

echo "[verify-build] OK — binary at $BIN"
