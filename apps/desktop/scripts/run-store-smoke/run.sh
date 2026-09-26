#!/usr/bin/env bash
# Headless smoke for 工作流运行的存档(续跑那件事的落盘那一半)。
#
# 真的建一个 sqlite 库、真的写行、真的删行 —— 但脚下那个数据根换成临时目录
# (见 stubs/dataRoot.ts 里那句"没设就抛":指错地方等于拿空库盖掉用户的聊天记录)。
#
# **跑两趟**,因为要验的那一条按定义跨进程:上一次死掉时还在跑的那些,下一次启动
# 才会被标成 `interrupted`(见 main.ts 文件头)。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-run-store-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-run-store-data.XXXXXX)
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
# 只用得到内建模块,所以不需要能被解析到 app 的 node_modules(那个包在临时目录里)。
"$ESBUILD" scripts/run-store-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:node:fs=./scripts/db-persistence-smoke/stubs/fs.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

# 第一趟:写。**故意留一个 `running` 的行在库里。**
node "$OUT/smoke.mjs" write

# 第二趟:全新的进程 —— 它启动时跑迁移,上一趟留下的那一行就该变成 `interrupted`。
node "$OUT/smoke.mjs" verify
