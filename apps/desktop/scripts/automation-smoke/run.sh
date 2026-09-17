#!/usr/bin/env bash
# Headless smoke for 自动化的两个新节点(触发器 + 决策节点)。
#
# 调度器那一半(scheduler-smoke 的写法):esbuild 打包 + 假 RunPorts,纯 node 跑。
# 会话那一半要真库:脚下那个数据根换成临时目录 —— 复用 run-store-smoke 的两个 stub
# (`dataRoot` 没设环境变量就抛,`logger` 静音),跑完连目录一起删,不碰用户真正的数据。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-automation-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-automation-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# `--banner` 给 sql.js 的 asm 构建一个真的 require(见 run-store-smoke/run.sh 同一段)。
"$ESBUILD" scripts/automation-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"
node "$OUT/smoke.mjs"
