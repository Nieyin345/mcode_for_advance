#!/usr/bin/env bash
# Headless smoke for 记忆系统(MEM-01 存储 / MEM-02 检索注入 / MEM-03 维护)。
#
# 写法与 automation-smoke 同一条路:esbuild 打包 + node 直跑,不进 Electron。
# `store.ts` 依赖 `@main/lib/dataRoot.js`(真的那个 import electron),这里换上
# run-store-smoke 的桩 —— 数据根指到临时目录,环境变量没设时桩会直接抛,指不进
# 用户真正的数据。跑完连目录一起删。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-memory-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-memory-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/memory-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/store/repositories.js=./scripts/memory-smoke/stubs/repositories.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/memory-smoke/stubs/pluginManager.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"
node "$OUT/smoke.mjs"
