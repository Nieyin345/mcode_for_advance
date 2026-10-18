#!/usr/bin/env bash
# 【ARC-006 Gate C 第一片】WorkflowDoc → Node-RED flow 迁移器（纯函数）+ 无损备份。
# 不联网、不起 Electron、不碰用户数据根：备份指向本套自己的 mktemp 目录。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-flow-migration.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-flow-migration-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# 迁移器与备份模块只 import @contracts 与 @main/lib/atomicFile（叶子模块），
# 不需要 electron 桩。给的 DATA 只用于备份落盘断言。
"$ESBUILD" scripts/flow-migration-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_FLOW_MIGRATION_DATA="$DATA" node "$OUT/smoke.mjs"
