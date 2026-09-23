#!/usr/bin/env bash
# Headless smoke for PDF 真批注 —— 坐标换算 + 写回文件。
#
# ⚠️ **它会真的写 PDF 文件** —— 所以全程在一个临时目录里拿 fixture 的副本练手,
#    跑完就删,绝不碰用户真的论文。
#
# 别名的理由(与 library-intake-smoke 同):
#   - electron 整个包 —— `ipc/library.ts` 那条链会把它拖进来;
#   - window / RuntimeManager / BrowserManager / library-http —— 那几个真家伙会开
#     浏览器、发网络请求;
#   - workflows/seed —— 非有不可:`registerLibraryHandlers` 注册时调 ensureWorkflows(),
#     它底层是 Vite `?raw` 导入的 .py,esbuild 会以 "No loader is configured" 挂掉。
#
# ⚠️ **pdfjs-dist 必须 external。** 它是个大包、带浏览器/worker 分支，bundle 进来
#    会炸(`Buffer`/`process` 在多环境垫片下);而这是跑在 node 里的无头套件 ——
#    让 node 自己去 node_modules 解析就行。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-pdf-annot-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
ln -s "$PWD/node_modules" "$OUT/node_modules"

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/pdf-annotation-smoke/main.ts \
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

node "$OUT/smoke.mjs"
