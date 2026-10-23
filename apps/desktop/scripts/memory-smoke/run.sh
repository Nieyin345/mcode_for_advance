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
source "$(dirname "$0")/../lib/esbuild-path.sh"

# 【MC-092/093 真实入口】本套现在要经**真** `app_api_call`(invokeAppTool)调记忆 RPC —— 那是
# 界面按按钮与 agent 共用的同一段代码。`tools.ts` 的静态/动态 import 图里有 `@main/window.js`
# (electron 的 webContents.send)、`electron` 本身、以及 `@main/claude/RuntimeManager.js`
# (动态 import,其真身拖进 ssh2 原生模块会在打包阶段卡死)。三者都用替身——本套不验界面/无窗口
# 那两路(见各桩文件头)。替身形状与 app-control-smoke 一致。
"$ESBUILD" scripts/memory-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/memory/broadcast.js=./scripts/mcp-endpoint-smoke/stubs/memoryBroadcast.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/store/repositories.js=./scripts/memory-smoke/stubs/repositories.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/memory-smoke/stubs/pluginManager.ts \
  --alias:@main/workflows/seed.js=./scripts/library-delete-smoke/stubs/workflowsSeed.ts \
  --alias:@main/window.js=./scripts/app-control-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/app-control-smoke/stubs/runtimeManager.ts \
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"
mkdir -p "$DATA/home"
export HOME="$DATA/home"
export USERPROFILE="$DATA/home"
node "$OUT/smoke.mjs"
