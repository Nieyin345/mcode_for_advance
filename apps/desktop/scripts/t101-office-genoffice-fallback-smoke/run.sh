#!/usr/bin/env bash
# 【T101】OnlyOffice 未配置时的 GenOffice 出口判据（扩展名 × 能力位组合表）。
# 纯逻辑 + 源码文本断言，不碰 Electron / 磁盘写入 / 数据库。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../.."
OUT=$(mktemp -d /tmp/mcode-t101-office.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"
"$ESBUILD" scripts/t101-office-genoffice-fallback-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
