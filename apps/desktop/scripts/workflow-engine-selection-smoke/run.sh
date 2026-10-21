#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-workflow-engine-selection.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-workflow-engine-selection-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi
"$ESBUILD" scripts/workflow-engine-selection-smoke/main.ts \
 --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
 --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
 --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
 --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
 --outfile="$OUT/smoke.mjs" --log-level=error
MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
