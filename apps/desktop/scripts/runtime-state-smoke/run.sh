#!/usr/bin/env bash
# Headless smoke for runtime state / persistence 边界(PAR-B)。
#
# 真的建一个 sqlite 库、真的写行 —— 但脚下那个数据根换成临时目录(见 stubs/dataRoot.ts
# 里那句"没设就抛":指错地方等于拿空库盖掉用户的聊天记录)。单进程即可:跨进程的
# `interrupted` 迁移归 run-store-smoke,那份跑两趟。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-runtime-state-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-runtime-state-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# stubs 换掉 import 了 electron 的两个模块;`--banner` 给 sql.js 的 asm 构建一个真的
# `require`(详 run-store-smoke/run.sh 同一段注释)。
"$ESBUILD" scripts/runtime-state-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/runtime-state-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/runtime-state-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"
node "$OUT/smoke.mjs"
