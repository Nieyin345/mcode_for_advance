#!/usr/bin/env bash
# 重建 flow-preview（工作流小流程图的真浏览器预览台）并跑一遍 ui-probe 量它。
#
# 预览台把 `WorkflowFlowMini` 在一个受控文档 + 运行现场下渲染成一张静态页，
# 由 `scripts/ui-probe/drive-flow.mjs` 用真 Chrome 量几何/颜色/墨量/裁切。
# 见 docs/前端怎么核对.md。需要本机有 Chrome。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=.tmp/flow-preview
mkdir -p "$OUT"

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# 静态资源（html / css）原样拷过去，bundle 现打。
cp scripts/flow-preview/index.html "$OUT/index.html"
cp scripts/flow-preview/styles.css "$OUT/styles.css"

"$ESBUILD" scripts/flow-preview/entry.tsx \
  --bundle --platform=browser --format=iife --jsx=automatic \
  --tsconfig=tsconfig.json \
  --alias:@renderer/stores/sessionStore.js=scripts/flow-preview/store-stub.ts \
  --alias:@renderer/lib/api.js=scripts/flow-preview/api-stub.ts \
  --outfile="$OUT/bundle.js" --log-level=warning

cd scripts/ui-probe
node drive-flow.mjs
