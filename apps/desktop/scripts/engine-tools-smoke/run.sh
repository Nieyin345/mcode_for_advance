#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."          # → apps/desktop

# 这套只测纯策略模块 + 读 provider 源码断言接线,不建库、不起 Electron、不碰 ~/.mcode。
OUT=$(mktemp -d /tmp/mcode-engine-tools.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/engine-tools-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
