#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p .tmp
OUT=$(mktemp -d ./.tmp/mcode-registry-guard-build.XXXXXX)
DATA=$(mktemp -d "${TMPDIR:-/tmp}/mcode-registry-guard-data.XXXXXX")
trap 'rm -rf "$OUT" "$DATA"' EXIT
source scripts/lib/esbuild-path.sh
"$ESBUILD" scripts/arc006-registry-guard-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --external:sherpa-onnx-node --external:ssh2 \
  --alias:electron=./scripts/mobile-pairing-smoke/stubs/electron.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
