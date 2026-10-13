#!/usr/bin/env bash
# Headless smoke for **场景部署的持久化**(MC-058 / ARC-002:把 SceneDeployment 落进
# `scene_deployments` 表,真的建库、真的写行、真的重启读回)。
#
# 脚下那个数据根换成临时目录(见 run-store-smoke/stubs/dataRoot.ts 里那句"没设就抛":
# 指错地方等于拿空库盖掉用户的聊天记录)。**跑两趟**,因为"durable 跨进程"这件事按定义
# 要一个新进程才验得了:第一趟写(含物理写故障注入),第二趟全新进程读回。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-scene-deploy-persist.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-scene-deploy-persist-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

source "$(dirname "$0")/../lib/esbuild-path.sh"

# 被测的 store 链 import 了 electron;store 的两个宿主依赖(dataRoot/logger)与 fs 换桩。
# `--banner` 那行给 **sql.js** 的 asm 构建:它 `require("node:fs")`/`node:crypto`,而 ESM
# 输出没有 `require` —— 给它一个真的(从 node:module 来)。被测代码一行没改。
"$ESBUILD" scripts/scene-deploy-persist-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:node:fs=./scripts/db-persistence-smoke/stubs/fs.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

# 第一趟:写(含 durable 落盘 + 物理写故障注入 + 回滚)。
node "$OUT/smoke.mjs" write

# 第二趟:全新的 node 进程 —— 读回第一趟 durable 写下的那条部署。
node "$OUT/smoke.mjs" verify
