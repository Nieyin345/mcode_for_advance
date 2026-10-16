#!/usr/bin/env bash
# workflow-seed-smoke —— 【MC-053】出厂工作流播种名单损坏不许复活已删内容。
#
# **跑两趟**(与 run-store-smoke 同款):第一趟在一个空库里正常播种、删掉一个出厂
# 工作流;第二趟(新进程)把名单改成损坏值,再读列表 —— 被删的工作流必须**不回来**。
# 跨进程是这一条的题面:播种的"每进程只播一次"闸在进程内,重启才是用户真实遇到的
# 场景。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-workflow-seed-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-workflow-seed-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/workflow-seed-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:electron=./scripts/run-store-smoke/stubs/electron.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

# 第一趟:空库播种 → 删一个出厂工作流(名字进一个已知位置,第二趟读)。
node "$OUT/smoke.mjs" seed
# 第二趟:新进程。先正常读(名单健康,删的不复活)→ 验分类器 → 把名单留在损坏值上。
node "$OUT/smoke.mjs" verify
# 第三趟:又一个新进程,读到的是损坏名单 —— 被删的工作流必须仍不复活。
node "$OUT/smoke.mjs" verify-corrupt
