#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-conversation-session.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-conversation-session-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source scripts/lib/esbuild-path.sh
mcode_esbuild scripts/mcode-conversation-session-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
# Separately exercise the production dispatch boundary; its SQL dependency
# must use a disposable data root, not the real user's mcode.db.
mcode_esbuild scripts/mcode-conversation-session-smoke/runtime-message.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/mcode-node-pack-ports-smoke/stubs/electron.ts \
  --alias:@main/window.js=./scripts/mcode-node-pack-ports-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/mcode-node-pack-ports-smoke/stubs/runtimeManager.ts \
  --alias:@main/modules/service.js=./scripts/mcode-node-pack-ports-smoke/stubs/moduleService.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/runtime-message.mjs" --log-level=error
MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/runtime-message.mjs"
