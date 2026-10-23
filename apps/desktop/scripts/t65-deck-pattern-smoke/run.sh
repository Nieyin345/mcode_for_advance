#!/usr/bin/env bash
# 【T65】deck 反模式检查器。纯结构计算，不碰 Electron / 磁盘 / 数据库。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../.."
OUT=$(mktemp -d /tmp/mcode-t65-pattern.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"
"$ESBUILD" scripts/t65-deck-pattern-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
