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

DEST="src-tauri/binaries/code-crew-hook${EXT}"

# Cargo lays the hook out at different paths depending on flags:
#   - bare `cargo build [--release]`  → target/{debug,release}/code-crew-hook
#   - `cargo build --target <triple>` → target/<triple>/release/code-crew-hook
# `tauri build --target universal-apple-darwin` triggers the latter,
# and CI additionally lipo-merges into target/universal-apple-darwin/release/.
# Walk every plausible spot and pick the newest existing file.
shopt -s nullglob
candidates=( "src-tauri/target/release/code-crew-hook${EXT}" \
             src-tauri/target/*/release/code-crew-hook${EXT} \
             "src-tauri/target/debug/code-crew-hook${EXT}" )
shopt -u nullglob

newest=""
for f in "${candidates[@]}"; do
  if [ -z "$newest" ] || [ "$f" -nt "$newest" ]; then
    newest="$f"
  fi
done

if [ -z "$newest" ]; then
  # No fresh build anywhere. CI's "Build hook binary" step copies the
  # built binary into binaries/ directly, so trust whatever is already
  # there as long as it's non-empty.
  if [ -s "$DEST" ]; then
    echo "[copy-hook] no fresh build under target/; trusting existing $DEST"
    exit 0
  fi
  echo "[copy-hook] no built hook found and $DEST is missing/empty" >&2
  exit 1
fi

if [ ! -f "$DEST" ] || [ "$newest" -nt "$DEST" ]; then
  cp "$newest" "$DEST"
  echo "[copy-hook] copied $newest -> $DEST"
else
  echo "[copy-hook] $DEST already current (newest source=$newest)"
fi
