#!/usr/bin/env bash
# Headless smoke for 自定义 UI —— `@contracts/customUi` 的配置/布局/模板/条件,
# 以及 `main/customUi/targets.ts` 的批量展开。
#
# 纯模块(不 import electron / store),直接 bundle 就能跑,不需要任何桩。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-custom-ui-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/custom-ui-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
