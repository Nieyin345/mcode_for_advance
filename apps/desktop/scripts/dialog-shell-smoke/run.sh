#!/usr/bin/env bash
# Headless smoke for **`main/ipc/dialog.ts`** + **`main/ipc/shell.ts`**。
#
# 这一套押在两种"用户一定会信"的错法上:
#
#   - `dialog.ts` 的图片白名单/上限一旦判错,结果是一条**静默**的坏路径 ——
#     不该读的文件被读进内存(界面卡一下了事),或者查表被原型链吃掉之后拿一个
#     非字符串的 mimeType 给渲染端(拼出来是个打不开的 `<img>`)。
#   - `shell.ts` 的围栏一旦少了分隔符边界,项目根 `D:\proj\foo` 会把
#     `D:\proj\foobar\x.txt` **静默放行**;反过来大小写没归一,合法路径会被
#     **静默拒绝**(用户点「在文件管理器里显示」没反应)。
#
# ## 换桩的边界
#
#   - `electron` —— `stubs/electron.ts`,**记录型**(不是纯抛型):dialog 的返回值由
#     脚本喂,`shell.openPath` / `showItemInFolder` 的调用逐条记下来。这一套要能区分
#     「**拒绝了**」和「**根本没走到**」,纯抛型下这两件事都是"抛了",分不开。
#   - `node:fs/promises` —— `stubs/fsPromises.ts`,**真身转发 + 记账**(同一个对象:
#     `require("fs/promises") === require("fs").promises`,所以被测代码的行为一字不改)。
#     "不合格的文件没被读进内存"只有靠 readFile 的调用记录才分得出来 —— 读文件**不改
#     mtime**,而返回值上"先判后读"和"先读后判"长得一模一样。
#   - `@main/store/repositories.js` —— 用**真的**:`ProjectRepo.list()` 要真读得到项目根。
#
# ⚠️ **数据根必须是 `mktemp -d`。** 这一套真建库、真写 project 行(内部都是 `persist()`,
# **重写整个库文件**)。`stubs/dataRoot.ts` 那句"没设环境变量就抛"就是为这件事 —— 别去改它。
#
# ⚠️ `--alias:` **只认包名**,相对路径的 import 换不掉。所以这里一条 `--external` 都不用
# (混搭会产生两份模块实例,大面积假红)。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-dialog-shell-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-dialog-shell-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/dialog-shell-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/dialog-shell-smoke/stubs/electron.ts \
  --alias:node:fs/promises=./scripts/dialog-shell-smoke/stubs/fsPromises.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
