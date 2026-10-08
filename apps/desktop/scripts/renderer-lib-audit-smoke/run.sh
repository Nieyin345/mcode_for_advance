#!/usr/bin/env bash
# 渲染库审计回归 —— renderer/lib 的命令/快捷键/路径/模型缓存纯逻辑。
# 只 import type + 纯函数，esbuild 打包后直接 node 跑，不需要 --alias。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-renderer-lib-audit-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/renderer-lib-audit-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
