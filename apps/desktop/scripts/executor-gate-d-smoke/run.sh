#!/usr/bin/env bash
# Gate D: fake Node-RED child + actual production claim; isolated disk only.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p .tmp
OUT=$(mktemp -d ./.tmp/mcode-executor-gate-d.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-executor-gate-d-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source scripts/lib/esbuild-path.sh
"$ESBUILD" scripts/executor-gate-d-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --external:sherpa-onnx-node --external:ssh2 \
  --alias:electron=./scripts/mobile-pairing-smoke/stubs/electron.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
