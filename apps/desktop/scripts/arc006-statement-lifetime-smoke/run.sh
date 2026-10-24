#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
OUT=$(mktemp -d /tmp/mcode-arc006-statements.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-arc006-statements-db.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$HERE/../lib/esbuild-path.sh"
"$ESBUILD" scripts/arc006-statement-lifetime-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
export MCODE_SMOKE_DATA_ROOT="$DATA"
node "$OUT/smoke.mjs"
