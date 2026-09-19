#!/usr/bin/env bash
# Headless smoke for `main/library/trash.ts`(孤儿条目去哪儿)。
#
# 真的建一个 sqlite 库、真的建集合、真的删 —— 脚下那个数据根换成临时目录
# (见 stubs/dataRoot.ts 里那句"没设就抛":指错地方等于拿空库盖掉用户的资料库)。
#
# 只需要 dataRoot / logger 两个桩:被测的 trash.ts 与它下面的 repos 都是纯数据库,
# 不碰 electron(别的套件要换 BrowserManager / RuntimeManager 是因为它们的 import
# 图里有转换和下载那两条路,本套一条都不走)。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-trash-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-trash-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# `--banner` 那一行是给 sql.js 的(理由同 run-store-smoke/run.sh):它的 asm 构建里有
# `require("node:fs")`,而定死的 ESM 输出没有 `require`。
"$ESBUILD" scripts/library-trash-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
