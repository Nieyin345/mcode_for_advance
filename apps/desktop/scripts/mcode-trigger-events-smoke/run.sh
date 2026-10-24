#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
OUT=$(mktemp -d /tmp/mcode-trigger-events.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-trigger-events-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$HERE/../lib/esbuild-path.sh"
"$ESBUILD" scripts/mcode-trigger-events-smoke/main.ts --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/mcode-node-pack-ports-smoke/stubs/electron.ts \
  --alias:@main/window.js=./scripts/mcode-node-pack-ports-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/mcode-node-pack-ports-smoke/stubs/runtimeManager.ts \
  --alias:@main/modules/service.js=./scripts/mcode-node-pack-ports-smoke/stubs/moduleService.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
