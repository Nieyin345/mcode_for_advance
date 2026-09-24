#!/usr/bin/env bash
# Headless smoke for `renderer/lib/contentTag.ts` —— 引用/粘贴在提示词里的形状。
#
# 纯模块（不 import electron / store），直接 bundle 就能跑，不需要任何桩。
# 见 main.ts 顶部那三条规矩。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-content-tag-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/content-tag-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
