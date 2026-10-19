#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-library-writeback.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-library-writeback-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
ln -s "$PWD/node_modules" "$OUT/node_modules"
source "$(dirname "$0")/../lib/esbuild-path.sh"
"$ESBUILD" scripts/library-pdf-writeback-host-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --external:pdfjs-dist \
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/db-migrate-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/library-delete-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/library-delete-smoke/stubs/runtimeManager.ts \
  --alias:@main/browser/BrowserManager.js=./scripts/library-delete-smoke/stubs/browserManager.ts \
  --alias:@main/workflows/seed.js=./scripts/library-delete-smoke/stubs/workflowsSeed.ts \
  --outfile="$OUT/main.mjs" --log-level=error
MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/main.mjs"
