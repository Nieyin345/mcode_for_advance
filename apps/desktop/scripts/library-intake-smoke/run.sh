#!/usr/bin/env bash
# Headless smoke for **「检索结果入库会不会发 `library.item.imported`」** ——
# 也就是 `wf_auto_download` / `wf_auto_convert` 那两条内置自动化唯一的触发点。
#
# ⚠️ **它会真的往库里写条目、真的排下载任务、真的跑一轮下载队列** —— 所以数据根换成
# 本脚本自己的临时目录(复用 db-migrate-smoke 的 dataRoot/logger 桩),跑完就删,
# 绝不碰用户真正的资料库。网络那一层由 stubs/libraryHttp.ts + stubs/browserManager.ts
# 按住(它们一被调用就抛),所以这套一次网都不发。
#
# 别名八档,理由各不相同 —— 少任何一档都是"打包直接挂",而报出来的长相与被测代码
# 坏掉一模一样:
#   - **electron 整个包** —— ⚠️ `ipc/library.ts` **自己**就有
#     `import { shell } from "electron"`,经 theme 还有 `nativeTheme`。顺着 alias
#     一个个堵会变成打地鼠,而每漏一个报出来的是 esbuild 把真 electron 打成 CJS 之后
#     那句 `ERR_AMBIGUOUS_MODULE_SYNTAX`(它源码里同时有 require 和顶层 await)。
#   - dataRoot / logger —— 真的那两个 import 了 electron,db-migrate-smoke 的老桩;
#   - window —— 真那个拿着 BrowserWindow。本套要断言"入库后通知了界面";
#   - BrowserManager —— `ipc/library.ts` → `library/downloader.ts` → 它。真的那个会
#     开内嵌浏览器、带 cookie 去请求真实出版社站点。桩是**显式报错**式的;
#   - library/http —— 同上,经 `oaResolvers`。真的那个 spawn `curl` 打四五个真实
#     元数据 API。**这一档不是省事**:不退掉它,这套就成了"有时红有时绿";
#   - RuntimeManager —— `library/broadcast.ts` 拿它发 `library.item.imported`,
#     而**那正是本套要验的东西**。真那个一路拖到三个引擎实现。桩里把每条外部事件
#     记下来 —— 断言全部看它;
#   - workflows/seed —— ⚠️ **非有不可**:`registerLibraryHandlers` 在注册时调
#     `ensureWorkflows()`,而 seed → `workflows/searchScriptsAssets.ts` 是二十几个
#     Vite `?raw` 导入的 `.py` / `LICENSE`(连后缀都没有,配 loader 也盖不住),
#     esbuild 会以 `No loader is configured for ".py" files` 挂掉打包。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-lib-intake-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-lib-intake-data.XXXXXX)
# ⚠️ **给 bundle 一个 node_modules 视野。** `library/pdfText.ts` 里有一句
# `require.resolve("pdfjs-dist/package.json")`,那是在**运行期**从 bundle 自己的位置
# 解析的,而 esbuild 把它打进了临时目录,那儿没有 node_modules。
#
# 为什么本套也要:本套**不转 PDF**,但 `ipc/library.ts` 的 import 图里有它(经
# convert.ts),而 `require.resolve` 那一句在**模块加载时**就跑(`pdfText.ts` 顶层
# 里算 cMap 目录)。软链一份真的进去,而不是设 NODE_PATH —— 后者只管 CJS,而 pdf.js
# 自己那条动态 import 走 ESM(ESM 不认 NODE_PATH)。
ln -s "$PWD/node_modules" "$OUT/node_modules"
trap 'rm -rf "$OUT" "$DATA"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# `--external:pdfjs-dist` + 上面那条软链是一对,见软链处的说明。
"$ESBUILD" scripts/library-intake-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --external:pdfjs-dist \
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/db-migrate-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/library-intake-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/library-intake-smoke/stubs/runtimeManager.ts \
  --alias:@main/browser/BrowserManager.js=./scripts/library-intake-smoke/stubs/browserManager.ts \
  --alias:@main/library/http.js=./scripts/library-intake-smoke/stubs/libraryHttp.ts \
  --alias:@main/workflows/seed.js=./scripts/library-delete-smoke/stubs/workflowsSeed.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
