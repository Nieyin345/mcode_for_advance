#!/usr/bin/env bash
# published-tools-smoke —— 【MC-041】自建工作流发布为带参数的派生工具。
#
# 真 SQLite + 真 library + 真 publishedTools:声明 inputSchema 的工作流 → 发布 →
# 按名字检索(并入 app_api_list)→ describe 看参数 → params 校验(好参放行 / 坏参
# 执行前拒绝)→ 撤销后检索不到。不起 Electron、不碰用户库(MCODE_SMOKE_DATA_ROOT)。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d /tmp/mcode-published-tools.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-published-tools-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$HERE/../lib/esbuild-path.sh"

"$ESBUILD" scripts/published-tools-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:electron=./scripts/run-store-smoke/stubs/electron.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --external:sherpa-onnx-node --external:cpu-features \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
