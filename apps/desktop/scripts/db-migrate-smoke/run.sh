#!/usr/bin/env bash
# Headless smoke for 数据库的**升级路径**(老结构库 → migrate() 补列 → 数据不丢)。
#
# 与 run-store-smoke 的分工:那边走"全新空库"(建表语句里列就是全的,兼容段一行
# 不执行);这边手工造一个**老结构的库文件**,让 initDb() 自己走 ALTER 兼容段。
# 老用户升级才踩得到的那段代码,只有这里测得到(见 main.ts 文件头)。
#
# 真的建一个 sqlite 库文件、真的跑迁移、真的把磁盘文件重新打开核对 —— 但脚下那个
# 数据根换成临时目录(见 stubs/dataRoot.ts 里那句"没设就抛":指错地方等于拿空库
# 盖掉用户的聊天记录)。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-db-migrate-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-db-migrate-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# 那两个模块 import 了 electron,换掉(见 stubs/)。被测的那份代码一行都没改。
#
# `--banner` 那一行是给 **sql.js** 的:它的 asm 构建里有 `require("node:fs")` /
# `require("node:crypto")`,而定死的 ESM 输出**没有 `require`** —— esbuild 会把它换成
# 一句 `throw new Error('Dynamic require of "node:fs" is not supported')`。给它一个
# 真的 `require`(从 `node:module` 的 `createRequire` 来),它就能跑。
"$ESBUILD" scripts/db-migrate-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/db-migrate-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
