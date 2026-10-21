#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."
OUT=$(mktemp -d /tmp/mcode-t28-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-t28-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$SCRIPT_DIR/../lib/esbuild-path.sh"
"$ESBUILD" scripts/genoffice-native-view-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/window.js=./scripts/document-view-host-smoke/stubs/window.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --outfile="$OUT/view.mjs" --log-level=error
MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/view.mjs"
# Snapshot absent: force the same stub alias selected by electron.vite.config.ts.
"$ESBUILD" scripts/genoffice-native-view-smoke/stub.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:electron=./scripts/genoffice-native-view-smoke/electron.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --outfile="$OUT/stub.mjs" --log-level=error
MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/stub.mjs"
if [[ -f ../../genoffice/apps/pdf/src/main/mcode-view-ai.ts ]]; then
  "$ESBUILD" scripts/genoffice-native-view-smoke/ai.ts \
    --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
    --banner:js="import { createRequire as __cr } from 'node:module'; const require=__cr(import.meta.url);" \
    --alias:@main/window.js=./scripts/document-view-host-smoke/stubs/window.ts \
    --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
    --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
    --outfile="$OUT/ai.mjs" --log-level=error
  MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/ai.mjs"
else
  echo "genoffice-native-view-smoke: vendor AI source unavailable; stub build tested separately"
fi
# T53: when upstream is present but Rust binary missing, sheets must fail closed.
"$ESBUILD" scripts/genoffice-native-view-smoke/resource.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:electron=./scripts/genoffice-native-view-smoke/electron.ts \
  --alias:@main/document/genofficeNativeVendor.js=./scripts/genoffice-native-view-smoke/resourceVendor.ts \
  --outfile="$OUT/resource.mjs" --log-level=error
MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/resource.mjs"
# T53: real Rust sidecar and GenOffice's native XLSX save path, plus real PPTX
# transactions through Mcode's fallback executor. Only isolated temp copies.
if [[ -f ../../genoffice/apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar.exe || \
      -f ../../genoffice/apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar ]]; then
  node scripts/genoffice-native-view-smoke/build-real.mjs "$OUT/real.mjs"
  MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/real.mjs"
else
  echo "genoffice-native-view-smoke: real sidecar not installed; T53 real-file checks unavailable"
fi
