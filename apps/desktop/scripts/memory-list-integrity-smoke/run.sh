#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-memory-list.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-memory-list-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
"$ESBUILD" scripts/memory-list-integrity-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/memory/broadcast.js=./scripts/mcp-endpoint-smoke/stubs/memoryBroadcast.ts \
  --alias:@main/store/repositories.js=./scripts/memory-smoke/stubs/repositories.ts \
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
  --outfile="$OUT/main.mjs" --log-level=error
mkdir -p "$DATA/home"
MCODE_SMOKE_DATA_ROOT="$DATA" HOME="$DATA/home" USERPROFILE="$DATA/home" node "$OUT/main.mjs"
