#!/usr/bin/env bash
# Headless smoke for 资料库里给自动化用的那几条 MCP 工具
# (`library_convert` / `library_links` / `library_link_add` / `library_link_remove`)。
#
# **它会真的往"库根"里写文件**(转换产物落 `markdown/`)—— 所以数据根必须换成临时
# 目录(复用 db-migrate-smoke 的 dataRoot/logger 桩),跑完就删,绝不碰用户真正的资料库。
#
# 别名分三档,理由各不相同(见各自 stub 的文件头):
#   - dataRoot / logger —— 真的那两个 import 了 electron,db-migrate-smoke 的老桩;
#   - window —— 真那个拿着 BrowserWindow。**不能借用 library-import-smoke 那份**:
#     本套的 `library_convert` 会拉到 `BrowserManager.ts`,它还要 `getMainWindow`,
#     那一份没这个成员;
#   - RuntimeManager —— `library/broadcast.ts` 拿它发 `library.item.imported`。真那个
#     一路拖到三个引擎实现 → `workflows/seed.ts` 的二十几个 `?raw` 的 `.py`/LICENSE
#     (esbuild 认不出那些后缀)。与 library-import-smoke 同一个切法、同一个桩 —— 顺带
#     也让"改完之后有没有通知界面"可断言;
#   - BrowserManager / theme / secretStore —— 这一套新拖进来的:electron 的那一截在
#     **下载**那条路上(convert.ts → downloader.ts → BrowserManager.ts),本套一次都
#     不走它,但 import 图会拉到。三个都是显式报错式的替身,不是空实现。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-lib-mcp-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-lib-mcp-data.XXXXXX)
# ⚠️ **给 bundle 一个 node_modules 视野。** `library/pdfText.ts` 里有一句
# `require.resolve("pdfjs-dist/package.json")`(`cMapUrl()` 要拿它的目录),而那是在
# **运行期**从 bundle 自己的位置解析的 —— esbuild 把它打进了临时目录,那儿没有
# node_modules,于是本地抽取这条路会以"Cannot find module 'pdfjs-dist/package.json'"
# 失败。那个失败看起来和"被测代码坏了"一模一样。
#
# 软链一份真的进去,而不是设 `NODE_PATH`:后者只管 CJS 的 require,而 pdf.js 自己那条
# 动态 import 走的是 ESM(ESM 不认 NODE_PATH)。软链对两种都成立。
ln -s "$PWD/node_modules" "$OUT/node_modules"
trap 'rm -rf "$OUT" "$DATA"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/library-mcp-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --external:pdfjs-dist \
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/db-migrate-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/library-mcp-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/library-import-smoke/stubs/runtimeManager.ts \
  --alias:@main/browser/BrowserManager.js=./scripts/library-mcp-smoke/stubs/browserManager.ts \
  --alias:@main/lib/theme.js=./scripts/library-mcp-smoke/stubs/theme.ts \
  --alias:@main/lib/secretStore.js=./scripts/library-mcp-smoke/stubs/secretStore.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
