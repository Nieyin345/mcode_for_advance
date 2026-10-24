#!/usr/bin/env bash
# 【T120】图片灯箱 pan/zoom：数学 + 交互 + 接入 + 上游常数核对。
# 纯函数，不需要 Electron / DOM / 数据库。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../.."
source "$HERE/../lib/esbuild-path.sh"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/mcode-image-panzoom-smoke.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/image-panzoom-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
