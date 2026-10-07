#!/usr/bin/env bash
# Headless smoke for `ipc/notifications.ts`(通知偏好的读写 + 点通知跳会话)。
#
# ## ⚠️ 这一套真的写库
#
# `SettingRepo.set` 内部是 `persist()` —— **一次点击就重写整个 `mcode.db`**。所以数据根
# 换成本脚本自己的临时目录(复用 run-store-smoke 的 dataRoot/logger 桩,那个桩**没设
# 环境变量就抛**),跑完就删。指错地方等于拿空库盖掉用户的聊天记录。
#
# ## 别名三档,理由各不相同
#
#   - **electron 整个包** —— `NotificationManager` 自己文件里就有
#     `import { Notification } from "electron"`,不经过任何 `@main/*` 中转,顺着别名
#     一个个堵会变成打地鼠(见 stubs/electron.ts 的文件头)。本套要验的两个 handler
#     碰不到任何 Electron API;
#   - dataRoot / logger —— 真的那两个 import 了 electron(`app.getPath`);
#   - window —— 真那个拿着 BrowserWindow。本套要断言"窗口被怎么拉起来的",所以桩里
#     记下 `restore`/`show`/`focus` 的**顺序**和推给界面的每一条;
#   - RuntimeManager —— `NotificationManager` 拿它订阅事件观察者,真那个一路拖到
#     三个引擎的 SDK。本套不从事件那条路验(那是 frontend-smoke 的活)。
#     ⚠️ **只换这一个** —— `NotificationManager` 自己留真的,本套验的一半就是
#     "内存里那份 prefs",换掉它等于验桩自己。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-notif-ipc-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-notif-ipc-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

# ⚠️ **banner 里那两行是给 `__dirname` 补的,别删。** `NotificationManager` 顶层有一句
# `join(__dirname, "../../build/icon.png")`(通知卡片的图标),esbuild 会把 `__dirname`
# **原样留着** —— ESM 里它根本不存在。缺了它,报的是 `ERR_AMBIGUOUS_MODULE_SYNTAX`
# (「同时有 require 和顶层 await」),**指向 banner 自己**,看起来像引号打错了。
"$ESBUILD" scripts/notifications-ipc-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fup } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __dirname = __dn(__fup(import.meta.url));" \
  --alias:electron=./scripts/notifications-ipc-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/notifications-ipc-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/notifications-ipc-smoke/stubs/runtimeManager.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
