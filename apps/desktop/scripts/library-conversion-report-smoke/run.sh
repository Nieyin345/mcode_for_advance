#!/usr/bin/env bash
# Headless smoke for `conversionReport` 的配图判据(`main/library/convert.ts`)。
#
# 它只 import 到 `paths.ts` / `store/repositories.ts`(→ `db.ts` → electron + sql.js),
# 所以别名只要 dataRoot / logger 两个(见 db-migrate-smoke 的桩)。数据根换成临时目录,
# 跑完就删 —— 本套会真的建库、真的往"库根"里写 Markdown。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-convreport-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-convreport-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/library-conversion-report-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/db-migrate-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
