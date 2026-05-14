#!/bin/bash
set -e
cd "$(dirname "$0")/.."
HOST=$(rustc -vV | sed -n 's|host: ||p')
EXT=""
[[ "$HOST" == *"windows"* ]] && EXT=".exe"
SRC="src-tauri/target/debug/code-crew-hook${EXT}"
DEST="src-tauri/binaries/code-crew-hook${EXT}"
if [ -f "$SRC" ]; then
  cp "$SRC" "$DEST"
  echo "[copy-hook] copied to $DEST"
fi
