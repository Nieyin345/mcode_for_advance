#!/usr/bin/env bash
# Headless smoke for mcode-app(本地 agent 控制 Mcode 的工具组)。esbuild 打包 + node 直跑,不进 Electron。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-app-control-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

# ⚠️ `--alias:@main/claude/RuntimeManager.js` 是**必需的**,不是保险。【MC-059】之后
# `appControl/tools.ts` 的 headlessNewSession / headlessSend 会**动态** import RuntimeManager,
# 而 esbuild 打动态 import 时照样把整条图收进 bundle —— 真的 RuntimeManager 那条链里有
# `agentTools → agentRemoteSsh → ssh2 → cpu-features.node`(原生模块),打包阶段就卡死
# (同 publicMcpSession.ts 文件头记过的那次)。本套不验无窗口那一路(那条回归在
# claude-ipc-smoke,它才有真 SQLite),这里换成显式抛的替身即可。
"$ESBUILD" scripts/app-control-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/window.js=./scripts/app-control-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/app-control-smoke/stubs/runtimeManager.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
