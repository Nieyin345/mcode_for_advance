#!/usr/bin/env bash
# M33 维护套件:导入链路上"错了不报错"的四处(详见 main.ts 文件头)。
#
# ⚠️ **它会真的往库里写条目、真的在临时数据根下建文件** —— 数据根换成自己的
# 临时目录(复用 db-migrate-smoke 的 dataRoot/logger 桩),跑完就删,绝不碰
# 用户真正的资料库。只用 fixture,不触任何真实第三方服务。
#
# 别名与 library-entry-path-smoke 逐档一致,理由相同(见那份 run.sh 的长注释):
#   - electron 整包 —— `ipc/library.ts` 自己 import 了它;
#   - window / RuntimeManager / BrowserManager —— import 图拖进来的,真的那几个
#     会开浏览器、发网络请求;
#   - workflows/seed —— `registerLibraryHandlers` 注册时调 `ensureWorkflows()`,
#     底层是二十几个 Vite `?raw` 的 `.py`,esbuild 打不动。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-maint-m33-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-maint-m33-data.XXXXXX)
# 给 bundle 一个 node_modules 视野 —— `library/pdfText.ts` 顶层有
# `require.resolve("pdfjs-dist/package.json")`,运行期从 bundle 位置解析。
ln -s "$PWD/node_modules" "$OUT/node_modules"
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/maint-m33-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --external:pdfjs-dist \
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/db-migrate-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/fixtures/library-stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/fixtures/library-stubs/runtimeManager.ts \
  --alias:@main/browser/BrowserManager.js=./scripts/fixtures/library-stubs/browserManager.ts \
  --alias:@main/workflows/seed.js=./scripts/library-delete-smoke/stubs/workflowsSeed.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
