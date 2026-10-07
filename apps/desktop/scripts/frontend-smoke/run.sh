#!/usr/bin/env bash
# Headless smoke for **「没崩,但用户看到的不是实话」**那一类(见 main.ts 的文件头)。
#
# 被测的是 `NotificationManager` —— 它决定"某个事件到达时该不该弹系统通知、弹的什么字"。
# 整套的关键在**换掉 electron 本身**(不只是换 `@main/window.js`):那个类直接
# `import { Notification } from "electron"`,顺着 alias 一个个堵会变成打地鼠。桩把
# `show()` 记下来,于是"弹没弹、弹的什么字"变成可断言的(见 stubs/electron.ts 的说明)。
#
# 数据根换成临时目录(复用 db-migrate-smoke 的 dataRoot/logger 桩),跑完就删 ——
# 绝不碰用户真正的数据根。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-frontend-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-frontend-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

# `main.ts` 用**相对路径** import 桩(绕开 @main 映射,typecheck 才不会去对真模块
# 要测试钩子);run.sh 这里再把被测代码内部的引用也指过去 —— 两个入口解析到同一个
# 文件,bundle 里就是同一个模块实例,`shown` 数组两边看得见。
#
# ⚠️ `--alias:electron=...` 必须排在前面:esbuild 的 alias 对**裸包名**一样生效。
#
# ⚠️ **banner 里那两行是给 `__dirname` 补的,别删。** 老几套的 banner 只造 `require`,
# 够用是因为它们拉的模块里没人用 `__dirname`。而 `NotificationManager` 有一句
# `join(__dirname, "../../build/icon.png")`(通知卡片的图标),esbuild 会把 `__dirname`
# **原样留着** —— ESM 里它根本不存在,于是 node 报
# `ERR_AMBIGUOUS_MODULE_SYNTAX`:「同时有 require() 和顶层 await,判不出模块格式」。
# 那句报错**指向 banner 自己**,看起来像引号打错了,其实是被测文件里少了个变量。
# 补上之后它算出来的是**临时目录**,图标自然找不到 —— 无所谓,本套不验图标。
"$ESBUILD" scripts/frontend-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fup } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __dirname = __dn(__fup(import.meta.url));" \
  --alias:electron=./scripts/frontend-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/db-migrate-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/frontend-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/frontend-smoke/stubs/runtimeManager.ts \
  --alias:@main/browser/BrowserManager.js=./scripts/library-mcp-smoke/stubs/browserManager.ts \
  --alias:@main/lib/theme.js=./scripts/library-mcp-smoke/stubs/theme.ts \
  --alias:@main/lib/secretStore.js=./scripts/library-mcp-smoke/stubs/secretStore.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
