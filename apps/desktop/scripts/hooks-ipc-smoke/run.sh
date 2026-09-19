#!/usr/bin/env bash
# Headless smoke for **`src/main/ipc/hooks.ts`** —— 钩子那五条 RPC 的那一层。
#
# 这一套走**真的 handler**(`registerHookHandlers` 注册进来的那批被收下来按 channel 调),
# 所以它会真的写 `hooks.json`、也真的起子进程(命令是 `node 那个脚本`)。
#
# ⚠️ **dataRoot 必须指向临时目录。** 真的 `hooks.json` 就在用户的数据根下,指错地方等于
# 拿一份空配置盖掉他亲手写的钩子(见 stubs/dataRoot.ts 里那句"没设就抛")。
#
# ## 为什么 `electron` 整个包换掉,而不是一个个 `--alias:@main/window.js`
#
# `registerHookHandlers` 的 import 图里有 `@main/hooks/HookRunner.js`,而它 import
# `@main/claude/RuntimeManager.js` —— 那个文件的 import 图一路拖到 `window.js`、
# `lib/secretStore.js`、`providers/registry.js` 等一串 electron 使用者。顺着 alias 一个个
# 堵会变成打地鼠,而每漏一个报出来的都是 "找不到模块 electron" 或 "Cannot determine
# intended module format",看着和"被测代码坏了"一模一样(理由详见
# `scripts/library-delete-smoke/stubs/electron.ts`)。换掉整个包更窄也更准 —— 本套要验的
# 五个 handler 一个 Electron API 都不碰,真被调到了会**显式抛**。
#
# `@main/store/db.js` 的 import 图里没有 `?raw`(那只有 orchestration/* 有),所以不需要
# 再给 `.py` / `.md` 配 loader。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-hooks-ipc-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-hooks-ipc-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# `--banner` 那一行是给 **sql.js** 的(本套的 import 图里有 store/db):它内部有
# `require("node:fs")`,而定死的 ESM 输出没有 `require`。
"$ESBUILD" scripts/hooks-ipc-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/library-delete-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/hook-runner-smoke/stubs/runtimeManager.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

# 脚本自己也认这个变量(它指向自己的临时数据根);在这儿一并导出,是为了那一路在
# "没设就抛"的桩下也起得来。
export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
