#!/usr/bin/env bash
# MAINT-2026-09 / M23 独占回归:turn.done{interrupted} 陈旧守卫 vs 外部中断。
# 与 session-store-smoke 同一套无头加载方式(esbuild 打包 + prelude 浏览器全局替身)。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-maint-m23-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then echo "maint-m23-smoke: installed esbuild required (no download)" >&2; exit 1; fi

"$ESBUILD" scripts/maint-m23-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --external:@renderer/lib/monacoSetup.js \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
