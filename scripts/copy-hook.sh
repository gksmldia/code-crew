#!/bin/bash
# Refresh src-tauri/binaries/code-crew-hook from the freshly built binary
# so tauri-bundler picks up the current hook into the .app's Resources/.
# Without this, the bundled hook stays frozen at whatever was manually
# copied in once — leading to silently-dead hooks after server-side
# changes (e.g. the :19876→dynamic-port migration).
#
# Wired into tauri.conf.json's `build.beforeBundleCommand` so it runs
# right after cargo build and right before tauri-bundler copies
# bundle.resources. Also safe to run by hand for dev mode.
set -e
cd "$(dirname "$0")/.."
HOST=$(rustc -vV | sed -n 's|host: ||p')
EXT=""
[[ "$HOST" == *"windows"* ]] && EXT=".exe"

# Prefer the release build (what tauri build produces); fall back to
# debug for manual dev-mode invocations.
RELEASE="src-tauri/target/release/code-crew-hook${EXT}"
DEBUG="src-tauri/target/debug/code-crew-hook${EXT}"
DEST="src-tauri/binaries/code-crew-hook${EXT}"

if [ -f "$RELEASE" ] && { [ ! -f "$DEBUG" ] || [ "$RELEASE" -nt "$DEBUG" ]; }; then
  SRC="$RELEASE"
elif [ -f "$DEBUG" ]; then
  SRC="$DEBUG"
else
  echo "[copy-hook] no built hook found (neither $RELEASE nor $DEBUG)" >&2
  exit 1
fi

cp "$SRC" "$DEST"
echo "[copy-hook] copied $SRC -> $DEST"
