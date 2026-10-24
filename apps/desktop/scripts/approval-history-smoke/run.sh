#!/usr/bin/env bash
# 【T109】审批历史 —— approvals 表 + 五个结算出口 + approval.list 的回归。
#
# ⚠️ 这一套**真建库**（sql.js 会重写整个 mcode.db）。数据根必须是 mktemp 目录：
# 指错地方等于拿空库盖掉用户的聊天记录。stubs/dataRoot.ts 那句「没设就抛」就是
# 为这件事 —— 别去改它。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."

OUT=$(mktemp -d /tmp/mcode-approval-history.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-approval-history-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$SCRIPT_DIR/../lib/esbuild-path.sh"

"$ESBUILD" scripts/approval-history-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/approval-history-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
