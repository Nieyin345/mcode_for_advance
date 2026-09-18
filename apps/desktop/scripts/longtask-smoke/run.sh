#!/usr/bin/env bash
# Headless smoke for 长期任务循环(taskRunner + contracts/longTask)。
#
# runner 行为那一半要真库 + RuntimeManager 替身:脚下数据根换成临时目录(复用
# run-store-smoke 的两个 stub),`@main/claude/RuntimeManager.js` 用 --alias 指到
# 本目录的替身(记录调用、手动喂事件,不拉 SDK 进程)。跑完连目录一起删。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-longtask-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-longtask-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/longtask-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/longtask-smoke/stub-runtime-manager.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"
node "$OUT/smoke.mjs"
