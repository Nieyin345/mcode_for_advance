#!/usr/bin/env bash
# 无人值守任务计划**渲染端**的回归网(MC-001 —— 后端全通、用户入口为零)。
#
# 判据全在 `src/renderer/components/settings/unattendedPlanView.ts` 那批**纯函数**上 +
# 一层源码正则 backstop(面板接线 / 挂载链 / policy 钉 blocked)—— 不碰 DOM / store / api,
# esbuild 打包后直接 node 跑(与 `scene-deploy-view-smoke` 同款)。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-unattended-plan-view-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/unattended-plan-view-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
