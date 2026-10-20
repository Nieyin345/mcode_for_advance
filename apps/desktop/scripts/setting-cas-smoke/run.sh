#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../.."
source "$HERE/../lib/esbuild-path.sh"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/mcode-setting-cas.XXXXXX")"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/mcode-setting-cas-data.XXXXXX")"
trap 'rm -rf "$OUT" "$DATA"' EXIT
"$ESBUILD" scripts/setting-cas-smoke/main.ts --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs" write
MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs" verify
