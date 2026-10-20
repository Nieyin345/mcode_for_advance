#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/lib/esbuild-path.sh
OUT=$(mktemp -d)
DATA=$(mktemp -d /tmp/mcode-owner-identity-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
# 【T10 后续】`executorOwnership.ts` 现在会拉进落盘实现，后者 import
# `@main/lib/dataRoot.js` 与 `@main/lib/logger.js`（都 import electron）。
# 与其它无头套件一致：两个都换桩，并给 esbuild 补 require/__dirname。
"$ESBUILD" scripts/executor-owner-identity-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
