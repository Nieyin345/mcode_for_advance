#!/usr/bin/env bash
# Headless smoke for 通用文件导入:`importGenericFiles` + `readEntryFile`。
# **它会真的往"库根"里写文件** —— 所以数据根必须换成临时目录(复用 db-migrate-smoke
# 的 stubs),跑完就删,绝不碰用户真正的资料库。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-lib-import-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-lib-import-data.XXXXXX)
# ⚠️ **给 bundle 一个 node_modules 视野**,并让 `pdfjs-dist` 外置。
# `library/pdfText.ts` 顶层有一句 `require.resolve("pdfjs-dist/package.json")`,在**运行期**
# 从 bundle 自己的位置解析,而 esbuild 把 bundle 打进临时目录,那儿没有 node_modules。
# 本套的「PDF 导入」那一段会真的走 `extractPdfMetadata` → 这条链,所以这对搭配是必需的
# (同 `library-intake-smoke` 里那一段,理由一致)。
ln -s "$PWD/node_modules" "$OUT/node_modules"
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

# 换掉 `@main/window.js` 与 `@main/claude/RuntimeManager.js`(理由见那两个 stub):
# 真的两个都 import 了 electron,而 RuntimeManager 还一路拖到三个引擎实现(每个都要
# `workflows/seed.js` 那二十几个 `?raw` 的 `.py`/LICENSE)。它们在这条路上的作用只有
# "把导入成功的两个信号送出去",桩里记下来 —— 顺带把"发了没有"也验了。
"$ESBUILD" scripts/library-import-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --external:pdfjs-dist \
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/db-migrate-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/library-import-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/library-import-smoke/stubs/runtimeManager.ts \
  --alias:@main/browser/BrowserManager.js=./scripts/fixtures/library-stubs/browserManager.ts \
  --alias:@main/workflows/seed.js=./scripts/library-delete-smoke/stubs/workflowsSeed.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
