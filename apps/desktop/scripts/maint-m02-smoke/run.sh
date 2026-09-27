#!/usr/bin/env bash
# Isolated M02 regression: forking transiently active sessions must not copy
# their running/approval state into the newly created session row.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-maint-m02.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-maint-m02-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then
  echo "Existing esbuild dependency not found; refusing network fallback." >&2
  exit 127
fi

"$ESBUILD" scripts/maint-m02-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/maint-m02-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/maint-m02-smoke/stubs/logger.ts \
  --alias:@main/lib/sessionSync.js=./scripts/maint-m02-smoke/stubs/sessionSync.ts \
  --alias:@main/providers/registry.js=./scripts/maint-m02-smoke/stubs/providerRegistry.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
