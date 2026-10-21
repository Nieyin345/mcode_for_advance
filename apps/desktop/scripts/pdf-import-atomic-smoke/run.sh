#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-pdf-import-atomic.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-pdf-import-atomic-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source scripts/lib/runtime-node-modules.sh
mcode_link_runtime_node_modules "$OUT" "$PWD/node_modules"
source "$(dirname "$0")/../lib/esbuild-path.sh"
"$ESBUILD" scripts/pdf-import-atomic-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --external:pdfjs-dist \
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/db-migrate-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/library-import-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/library-import-smoke/stubs/runtimeManager.ts \
  --alias:@main/browser/BrowserManager.js=./scripts/fixtures/library-stubs/browserManager.ts \
  --alias:@main/workflows/seed.js=./scripts/library-delete-smoke/stubs/workflowsSeed.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
