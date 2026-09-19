#!/usr/bin/env bash
# Headless smoke for 通用文件导入:`importGenericFiles` + `readEntryFile`。
# **它会真的往"库根"里写文件** —— 所以数据根必须换成临时目录(复用 db-migrate-smoke
# 的 stubs),跑完就删,绝不碰用户真正的资料库。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-lib-import-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-lib-import-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# 换掉 `@main/window.js` 与 `@main/claude/RuntimeManager.js`(理由见那两个 stub):
# 真的两个都 import 了 electron,而 RuntimeManager 还一路拖到三个引擎实现(每个都要
# `workflows/seed.js` 那二十几个 `?raw` 的 `.py`/LICENSE)。它们在这条路上的作用只有
# "把导入成功的两个信号送出去",桩里记下来 —— 顺带把"发了没有"也验了。
"$ESBUILD" scripts/library-import-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/db-migrate-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/library-import-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/library-import-smoke/stubs/runtimeManager.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
