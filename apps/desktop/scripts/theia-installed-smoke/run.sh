#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
cd "$ROOT/apps/desktop"
OUT=$(mktemp -d /tmp/mcode-theia-installed.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
ESBUILD=$(find "$ROOT/node_modules/.pnpm" -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then echo "esbuild unavailable" >&2; exit 2; fi
"$ESBUILD" "$HERE/main.ts" --bundle --platform=node --format=esm \
  --tsconfig="$ROOT/apps/desktop/tsconfig.json" \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error
MCODE_SMOKE_REPO_ROOT="$ROOT" node "$OUT/smoke.mjs"
