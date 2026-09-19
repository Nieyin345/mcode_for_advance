#!/usr/bin/env bash
# Headless smoke for **`HookRunner` 自己** —— 见 main.ts 文件头:事件该不该触发、
# 扣住的收口、并发互斥、按 mtime 重读、异常不出事件流。
#
# 这一套真的起子进程(钩子命令是 `node xxx.js`),也真的建库(会话要走真的
# SessionRepo)。所以数据根换临时目录是**必须的**,不是洁癖 —— 指错地方等于拿空库
# 盖掉用户的聊天记录(见 stubs/dataRoot.ts 里那句"没设就抛")。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-hook-runner-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-hook-runner-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# 换桩的三个,都是因为 import 了 electron:
#  - `dataRoot` / `logger` —— 同其它套件;
#  - `RuntimeManager` —— 它 import 了 `window.js`(`BrowserWindow`)。`HookRunner` 只用
#    它的 `subscribe` 和 `isTurnEndHeld`,桩里实现了那两个,外加脚本自己用的 `emit`。
#
# `--banner` 那一行是给 **sql.js** 的(会话/项目走真库):它内部有 `require("node:fs")`,
# 而定死的 ESM 输出没有 `require`。
"$ESBUILD" scripts/hook-runner-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/db-migrate-smoke/stubs/logger.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/hook-runner-smoke/stubs/runtimeManager.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
