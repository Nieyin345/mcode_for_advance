#!/usr/bin/env bash
# Headless smoke for mcode-app(本地 agent 控制 Mcode 的工具组)。esbuild 打包 + node 直跑,不进 Electron。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

# ⚠️ **产物目录必须在 `.tmp/` 下,不能是 `/tmp`。** 【MC-052】之后本套经 `--external:ssh2`
# 拉着 ssh2 的 import 到运行时,**由 node 从产物目录往上**找 `node_modules`;`/tmp` 在 Windows
# 上落到 `%LOCALAPPDATA%\Temp`,从那儿往上找不到仓库里的 `node_modules`(实测
# `ERR_MODULE_NOT_FOUND: Cannot find package 'ssh2'`)。`agent-mail-smoke` / `mcode-admin-smoke`
# 同一个位置。`.tmp/` 已在 .gitignore 里。
mkdir -p ./.tmp/app-control-smoke
# 【ARC-002】这一段现在要真 DB(发布派生工具 → 检索 → help → 结构化执行)。
# 数据根指向 mktemp 副本 —— sql.js 的 persist() 会重写整个 mcode.db,指错就是毁用户数据。
DATA=$(mktemp -d /tmp/mcode-app-control-data.XXXXXX)
trap 'rm -rf "$DATA"' EXIT
source "$HERE/../lib/esbuild-path.sh"

# ⚠️ `--alias:@main/claude/RuntimeManager.js` 是**必需的**,不是保险。【MC-059】之后
# `appControl/tools.ts` 的 headlessNewSession / headlessSend 会**动态** import RuntimeManager,
# 而 esbuild 打动态 import 时照样把整条图收进 bundle —— 真的 RuntimeManager 那条链里有
# `agentTools → agentRemoteSsh → ssh2 → cpu-features.node`(原生模块),打包阶段就卡死
# (同 publicMcpSession.ts 文件头记过的那次)。本套不验无窗口那一路(那条回归在
# claude-ipc-smoke,它才有真 SQLite),这里换成显式抛的替身即可。
#
# ⚠️ `--external:ssh2` 与 `--alias:@main/store/repositories.js` 是【MC-052】新加
# (本套现在**真**驱动 `agentRemoteSsh.ts` 的授权服务来证明 agent 路够不到 approveHost):
# 前者避开 cpu-features 原生模块(ssh2 的 import 运行时解析,故产物须在 `.tmp/` 下);
# 后者把 SettingRepo 换成内存表,让授权表 / known-hosts 落盘不碰 sql.js + electron。
"$ESBUILD" scripts/app-control-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --external:ssh2 \
  --external:typescript \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/window.js=./scripts/app-control-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/app-control-smoke/stubs/runtimeManager.ts \
  --alias:@main/store/repositories.js=./scripts/app-control-smoke/stubs/repositories.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --outfile=./.tmp/app-control-smoke/smoke.mjs --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node ./.tmp/app-control-smoke/smoke.mjs
