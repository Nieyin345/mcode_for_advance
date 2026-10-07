#!/usr/bin/env bash
# Headless editor save ordering/error smoke. The IPC API is stubbed; no real
# user file or database is opened. Run from the repo root via Git Bash.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-editor-save-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/editor-save-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:@renderer/lib/api.js=./scripts/editor-save-smoke/stubs/api.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
