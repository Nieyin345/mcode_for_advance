#!/usr/bin/env bash
# Headless smoke for `main/ipc/theme.ts` + `main/lib/theme.ts` + `main/ipc/app.ts`
# (主题偏好那一条链 / About 面板 / 数据根搬家)。
#
# 真的建一个 sql.js 库、真的写 settings 表、真的往临时目录搬一次数据根 ——
# **脚下那个数据根换成 `mktemp -d` 出来的目录**。这不是讲究:sql.js 的 `persist()`
# 是**重写整个 `mcode.db`**,指到真库等于拿空库盖掉用户的聊天记录。
# 搬家的目标同样是另一个 `mktemp -d` —— **绝不拿真路径试**。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-theme-ipc-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-theme-ipc-data.XXXXXX)
# 给 bundle 一个 node_modules 视野(sql.js / zod 那几个在运行期要按包名解析)。
ln -s "$PWD/node_modules" "$OUT/node_modules"
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

# ## 别名只有两条,这是刻意的
#
# 别的套件那一长串别名是因为它们 drag 进了 `ipc/library.ts` 那种「一手牵出二十几个
# 模块」的东西。这一套的被测面很窄 —— `ipc/theme.ts` 是 20 行、`ipc/app.ts` 是 65 行
# —— 只需要换掉两个:
#
#   * `electron` —— 没有真 Electron 可起(`nativeTheme` 要能读能写能手动触发
#     `updated`,`app` 要能数 `relaunch`/`exit`,并且 `getPath` 必须**没设
#     MCODE_SMOKE_DATA_ROOT 就抛**)。见 stubs/electron.ts。
#   * `@main/window.js` —— 要断言"推给界面的是什么",所以桩要记账而不是纯抛。
#
# ⚠️ **`@main/lib/dataRoot.js` 故意不换桩**,用真的。`APP_MOVE_DATA_ROOT` 要验的正是
# 它的拒绝口径(非空目录 / 相对路径 / 互相嵌套 / 自己是上级)—— 换个桩就成了"验桩",
# 而且"失败时什么都没动"这条断言会变成对着自己写的假数据断言。真 dataRoot 只 import
# `electron`(已换)和 logger,跑得起来。
#
# ⚠️ `@main/store/db.js` **也不换桩** —— 要真的建库、真的写盘,才能验「失败搬家之后
# 连接还活着」。它 import 的 `@main/lib/dataRoot.js` 与 main.ts、`ipc/app.ts` 里的
# 是**同一个说明符**(`@main/*` → `src/main/*`),esbuild 按解析后的绝对路径去重,
# 所以全文只有**一个** dataRoot 实例、一个 db 实例 —— 这正是"两套模块实例导致状态
# 对不上、满屏假红"那个坑的预防针(见 SKILL.md 里 `--alias` 的第二条)。
#
# `--banner` 那一行是给 sql.js 的(理由同 run-store-smoke/run.sh):它的 asm 构建里有
# `require("node:fs")`,而定死的 ESM 输出没有 `require`。
"$ESBUILD" scripts/theme-ipc-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/theme-ipc-smoke/stubs/electron.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/theme-ipc-smoke/stubs/window.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
