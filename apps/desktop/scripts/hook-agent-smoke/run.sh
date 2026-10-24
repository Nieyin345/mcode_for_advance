#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
OUT=$(mktemp -d /tmp/mcode-hook-agent.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-hook-agent-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$HERE/../lib/esbuild-path.sh"
"$ESBUILD" scripts/hook-agent-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/db-migrate-smoke/stubs/logger.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/hook-agent-smoke/stubs/runtimeManager.ts \
  --alias:@main/orchestration/runner.js=./scripts/hook-agent-smoke/stubs/workflow.ts \
  --alias:@main/orchestration/library.js=./scripts/hook-agent-smoke/stubs/library.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
