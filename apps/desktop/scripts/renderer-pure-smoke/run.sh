#!/usr/bin/env bash
# 渲染端**纯逻辑**三件的回归网 —— 这三个文件此前一套覆盖都没有:
#   - `ide/commitGraph.ts`   git 历史图的泳道排布
#   - `lib/lineDiff.ts`      行级 LCS diff
#   - `ide/turnFlowModel.ts` Turn Flow 面板的派生(分组/用量匹配/工具分类/计数)
#
# 三个都**不碰 DOM / store**(只 import type),所以 esbuild 打包后直接 node 跑,
# 不需要任何 --alias。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-renderer-pure-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/renderer-pure-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
