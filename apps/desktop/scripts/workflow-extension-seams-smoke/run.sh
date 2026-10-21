#!/usr/bin/env bash
# 【ARC-006】工作流节点扩展缝回归网（kind 三处同源 / 执行器注册表 / 用户交互归属）。
# 纯源码 + 契约对象断言，不碰磁盘数据；不需要 Electron。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-workflow-seams.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

source "scripts/lib/esbuild-path.sh"

mcode_esbuild scripts/workflow-extension-seams-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
