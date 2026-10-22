#!/usr/bin/env bash
# T21: the migration preflight (workflowMigrationPreflight, T85) and the
# per-document load journal (NodeRedFlowStorage) are now on the production load
# path (nativeLibraryLoad.ts is the only production entry that loads a library
# document into the Node-RED canvas, called from ipc/index.ts).
#
# This suite drives `loadWorkflowIntoNative` — the production function — with
# real isolated directories and fake runtime/launcher ports. It does not spin
# Electron, touch a real data root, or start Node-RED.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-t21-orphans.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "scripts/lib/esbuild-path.sh"
"$ESBUILD" scripts/t21-orphaned-adapters-wired-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
MCODE_SMOKE_DATA_ROOT="$OUT" node "$OUT/smoke.mjs"
