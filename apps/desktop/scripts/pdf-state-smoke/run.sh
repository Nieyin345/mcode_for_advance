#!/usr/bin/env bash
# Headless smoke for PDF 状态的两套判据(`lib/pdfState.ts`)。
#
# 为什么单独一套:那个状态有两份实现(渲染端 TS 推导 / 主进程 SQL 筛选),分居两个
# 包,谁加了新状态另一份都不会报错。失效是**静默**的 —— 界面上两句话都说得通。
# 详见 main.ts 的文件头。
#
# 这套会**真的建库、真的写 download_jobs**(`DownloadJobRepo.enqueue` 内部就是
# `persist()`,而 persist 重写整个 mcode.db),所以数据根必须是 mktemp 出来的那份。
# 指错地方就是拿空库盖掉用户的聊天记录 —— 见 stubs/dataRoot.ts「没设就抛」。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-pdf-state-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-pdf-state-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

# esbuild 是 vite 的传递依赖(不在直接依赖里),找不到就退回 npx。
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# 数据根与日志换桩 —— 真的那两个都 import 了 electron。
#
# `--banner` 那一行是给 **sql.js** 的(这套会真的建库):它内部有
# `require("node:fs")`,而定死的 ESM 输出没有 `require`。
"$ESBUILD" scripts/pdf-state-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/db-migrate-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
