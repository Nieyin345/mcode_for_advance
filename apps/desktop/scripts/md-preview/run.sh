#!/usr/bin/env bash
# 重建 md-preview（md 预览里图片那一环的真浏览器预览台）并跑一遍 ui-probe 量它。
#
# 验的是「预览里 md 图片是裂的」这条修复（`FileViewer` 给 `Markdown` 传 baseDir）
# 在真浏览器里**真的把图放出来了** —— 规划里这一条改过但从没在真浏览器看过图。
# 见 docs/前端怎么核对.md。需要本机有 Chrome。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=.tmp/md-preview
mkdir -p "$OUT"

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

cp scripts/md-preview/index.html "$OUT/index.html"
cp scripts/md-preview/styles.css "$OUT/styles.css"

"$ESBUILD" scripts/md-preview/entry.tsx \
  --bundle --platform=browser --format=iife --jsx=automatic \
  --tsconfig=tsconfig.json \
  --alias:@renderer/stores/sessionStore.js=scripts/md-preview/store-stub.ts \
  --alias:@renderer/lib/api.js=scripts/md-preview/api-stub.ts \
  --outfile="$OUT/bundle.js" --log-level=warning

cd scripts/ui-probe
node drive-md-image.mjs
