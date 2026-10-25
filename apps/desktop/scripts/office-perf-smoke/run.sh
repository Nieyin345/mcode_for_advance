#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../.."
source "$HERE/../lib/esbuild-path.sh"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/mcode-office-perf.XXXXXX")"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/mcode-office-perf-data.XXXXXX")"
trap 'rm -rf "$OUT" "$DATA"' EXIT
"$ESBUILD" scripts/office-perf-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/window.js=./scripts/document-view-host-smoke/stubs/window.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
# The actual Electron protocol.handler is exercised with a fake Electron only;
# it still imports production genofficeViewFactories and its real path resolver.
"$ESBUILD" scripts/office-perf-smoke/protocol.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:electron=./scripts/office-perf-smoke/electron.ts \
  --alias:@main/document/genofficeNativeVendor.js=./scripts/office-perf-smoke/vendor.ts \
  --outfile="$OUT/protocol.mjs" --log-level=error
MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/protocol.mjs"
