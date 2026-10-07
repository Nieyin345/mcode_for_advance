#!/usr/bin/env bash
# Headless smoke for 收藏(页书签)的两半:`main/browser/bookmarks.ts` +
# `main/ipc/browser.ts`。见 main.ts 文件头。
#
# ## 数据根必须换掉,这不是洁癖
#
# 书签存在设置表里,而 `SettingRepo.set` 内部就是 `persist()` —— 一次点击就够
# `sql.js` 的 `db.export()` 把**整个 `mcode.db` 重写一遍**。指错地方等于拿一个
# 空库盖掉用户的聊天记录。所以下面 `MCODE_SMOKE_DATA_ROOT` 指向 `mktemp -d`,
# 而 `stubs/dataRoot.ts` 在没设这个变量时**直接抛**。
#
# ## 换掉整包 electron
#
# 被测的 `ipc/browser.ts` 自己只用 `import type { IpcMain }`(编译后消失),但它拉的
# `@main/lib/pathGuard.js` → `@main/store/repositories.js` → `./db.js` 里有一句真的
# `import { app } from "electron"`。一刀切掉整个包比顺着 import 逐个堵便宜,也不会漏。
# (同 library-delete-smoke 的取舍;那边写了更长的理由。)
#
# ## ⚠️ `--alias:@main/browser/BrowserManager.js=…` 与"两份模块实例"
#
# `ipc/browser.ts` 用**包名**(`@main/browser/BrowserManager.js`)import 它,所以这一刀
# 是能换掉的 —— 脚本与主 bundle 解析到的是**同一个** specifier,esbuild 只打一份。
# 于是 `stubs/browserManager.ts` 里那个 `recorded` 数组就是真 handler 记进去的那一份。
#
# 反过来说:本套**不能**用相对路径去 import 由 `--alias` 换掉的那个模块(那样会得到
# 第二份实例、共享状态对不上、大面积变红)。所以 main.ts 里对桩的引用写的是
# `./stubs/browserManager.js` —— esbuild 按**同一个文件**解析,不多打一份。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-browser-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-browser-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

# `--banner` 那一行**非有不可**:sql.js 的 asm 构建里有 `require("node:fs")` /
# `require("node:crypto")`,而定死的 ESM 输出没有 `require` —— esbuild 会把它换成
# 一句 `throw new Error('Dynamic require of "node:fs" is not supported')`。
"$ESBUILD" scripts/browser-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/browser-smoke/stubs/electron.ts \
  --alias:@main/browser/BrowserManager.js=./scripts/browser-smoke/stubs/browserManager.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
