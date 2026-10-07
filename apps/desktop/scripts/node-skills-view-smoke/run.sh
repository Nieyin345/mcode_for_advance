#!/usr/bin/env bash
# Headless smoke for 「节点技能总览」读的那份数据形状 —— 见 main.ts 的头注。
#
# 纯数据（一个常量 + 一个收集算法），不碰磁盘、不碰数据库、不碰 electron。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-node-skills-view-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/node-skills-view-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
