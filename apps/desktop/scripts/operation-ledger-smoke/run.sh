#!/usr/bin/env bash
# Headless smoke for DurableOperationLedger 的 durableRevision 落账(ARC-009)。
# 真 sql.js + 真临时库;数据根指向 mktemp -d(指错地方等于拿空库盖掉用户数据)。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-op-ledger-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-op-ledger-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/operation-ledger-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:node:fs=./scripts/db-persistence-smoke/stubs/fs.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"
node "$OUT/smoke.mjs"
