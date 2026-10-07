#!/usr/bin/env bash
# Headless smoke for 入口节点「固定条件」的注入(只在这个对话的第一轮注一次)。
#
# 真的建一个 sqlite 库、真的写设置表 —— 但脚下那个数据根换成临时目录
# (见 stubs/dataRoot.ts 里那句"没设就抛":指错地方等于拿空库盖掉用户的聊天记录)。
#
# 被测的 `criteriaInject.ts` 刻意不 import `runner.ts`(那一头拖着 RuntimeManager 和
# 三家 provider),所以这里一行 RuntimeManager 的桩都不用打。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-criteria-inject-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-criteria-inject-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
source "$(dirname "$0")/../lib/esbuild-path.sh"

# `--banner` 那一行是给 **sql.js** 的:它的 asm 构建里有 `require("node:fs")` /
# `require("node:crypto")`,而定死的 ESM 输出**没有 `require`** —— esbuild 会把它换成
# 一句 `throw new Error('Dynamic require of "node:fs" is not supported')`。给它一个
# 真的 `require`(从 `node:module` 的 `createRequire` 来),它就能跑。
"$ESBUILD" scripts/criteria-inject-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/criteria-inject-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/criteria-inject-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
