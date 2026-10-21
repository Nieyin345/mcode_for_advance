#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."
OUT=$(mktemp -d /tmp/mcode-t83-tool-bridge.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$SCRIPT_DIR/../lib/esbuild-path.sh"
STUB=./scripts/t83-mcode-editor-tool-bridge-smoke/stubs/nativeAiMcode.ts
"$ESBUILD" scripts/t83-mcode-editor-tool-bridge-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/claude/RuntimeManager.js="$STUB" \
  --alias:@main/store/repositories.js="$STUB" \
  --alias:@main/providers/registry.js="$STUB" \
  --alias:@main/lib/pathGuard.js="$STUB" \
  --alias:@main/window.js="$STUB" \
  --alias:electron="$STUB" \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
