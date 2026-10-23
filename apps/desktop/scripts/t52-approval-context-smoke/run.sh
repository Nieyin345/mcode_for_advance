#!/usr/bin/env bash
# 【T52】审批卡摘要必须包含设置键名。
# 纯渲染端逻辑（`toolSummary`），不碰 Electron / 磁盘 / 数据库。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../.."
OUT=$(mktemp -d /tmp/mcode-t52-approval.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"
"$ESBUILD" scripts/t52-approval-context-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
