#!/usr/bin/env bash
# Headless smoke for `library.entryPath` —— 条目 id → 磁盘绝对路径。
#
# ⚠️ **它会真的往库里写条目、真的在临时数据根下建文件** —— 所以数据根换成自己的
# 临时目录(复用 db-migrate-smoke 的 dataRoot/logger 桩),跑完就删,绝不碰用户
# 真正的资料库。
#
# 别名与 library-intake-smoke **逐档一致**,理由也一样(见那一份 run.sh 的长注释):
#   - electron 整个包 —— `ipc/library.ts` 自己就 import 了它,顺着 alias 一个个堵
#     会变成打地鼠;
#   - window / RuntimeManager / BrowserManager / library-http —— 都是 `ipc/library.ts`
#     的 import 图拖进来的,真的那几个会开浏览器、发网络请求;
#   - workflows/seed —— ⚠️ **非有不可**:`registerLibraryHandlers` 注册时调
#     `ensureWorkflows()`,而它底层是二十几个 Vite `?raw` 导入的 `.py`,esbuild 会以
#     `No loader is configured for ".py" files` 挂掉打包。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-entry-path-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-entry-path-data.XXXXXX)
# 给 bundle 一个 node_modules 视野 —— `library/pdfText.ts` 顶层有
# `require.resolve("pdfjs-dist/package.json")`,运行期从 bundle 位置解析。
ln -s "$PWD/node_modules" "$OUT/node_modules"
trap 'rm -rf "$OUT" "$DATA"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/library-entry-path-smoke/main.ts \
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
