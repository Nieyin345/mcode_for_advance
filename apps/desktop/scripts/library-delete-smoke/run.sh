#!/usr/bin/env bash
# Headless smoke for **彻底删除**(`ipc/library.ts` 的 `library:deleteItems`)。
#
# 它真的会往"库根"里写文件、也真的会删文件 —— 所以数据根换成本脚本自己的临时目录
# (复用 db-migrate-smoke 的 dataRoot/logger 桩),跑完就删,绝不碰用户真正的资料库。
#
# 别名五档,理由各不相同:
#   - **electron 整个包** —— ⚠️ `ipc/library.ts` **自己**就有一句
#     `import { shell } from "electron"`,而经 BrowserManager / theme 还有 `nativeTheme`。
#     顺着 alias 一个个堵会变成打地鼠,而且每漏一个,报出来的是 esbuild 把真的 electron
#     打成 CJS 之后那句 `ERR_AMBIGUOUS_MODULE_SYNTAX`(它源码里同时有 require 和顶层
#     await)—— 看起来和"被测代码坏了"一模一样。见 stubs/electron.ts 的文件头;
#   - dataRoot / logger —— 真的那两个 import 了 electron,db-migrate-smoke 的老桩;
#   - window —— 真那个拿着 BrowserWindow。本套要断言"删完之后通知了界面",所以桩里
#     记下每条 `library:changed`;
#   - BrowserManager —— `ipc/library.ts` → `library/downloader.ts` → 它。整条下载
#     那一路在本套一次都不走,而且 BrowserManager 的依赖面很宽(注入脚本、theme、
#     snapshotScript),换桩比逐个补桩便宜。桩是**显式报错**式的;
#   - RuntimeManager —— `library/broadcast.ts` 拿它发 `library.item.imported`(通用
#     导入那一路)。本套不做导入事件断言,但 `ipc/library.ts` 的 import 图会拉到它,
#     而真那个一路拖到三个引擎实现;
#   - workflows/seed —— ⚠️ **这一档非有不可**:`ipc/library.ts` 注册时调
#     `ensureWorkflows()`,而 seed → `workflows/searchScriptsAssets.ts` 是二十几个
#     **Vite `?raw` 导入**的 `.py` / `LICENSE`,esbuild 会以
#     `No loader is configured for ".py" files` 直接挂掉打包。seed 与删除一个字都不沾,
#     桩里顺带记下"确实被调到了"。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-lib-delete-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-lib-delete-data.XXXXXX)
# ⚠️ **给 bundle 一个 node_modules 视野。** `library/pdfText.ts` 里有一句
# `require.resolve("pdfjs-dist/package.json")` —— 那是在**运行期**从 bundle 自己的位置
# 解析的,而 esbuild 把它打进了临时目录,那儿没有 node_modules。
#
# 为什么这套也要:本套**不转 PDF**,但 `ipc/library.ts` 的 import 图里有它(经
# convert.ts),而 `require.resolve` 那一句在**模块加载时**就跑(`pdfText.ts` 顶层
# 里算 cMap 目录)。软链一份真的进去,而不是设 NODE_PATH —— 后者只管 CJS 而 pdf.js
# 自己那条动态 import 走 ESM(ESM 不认 NODE_PATH)。
ln -s "$PWD/node_modules" "$OUT/node_modules"
trap 'rm -rf "$OUT" "$DATA"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/library-delete-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --external:pdfjs-dist \
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/db-migrate-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/library-delete-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/library-delete-smoke/stubs/runtimeManager.ts \
  --alias:@main/browser/BrowserManager.js=./scripts/library-delete-smoke/stubs/browserManager.ts \
  --alias:@main/workflows/seed.js=./scripts/library-delete-smoke/stubs/workflowsSeed.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
