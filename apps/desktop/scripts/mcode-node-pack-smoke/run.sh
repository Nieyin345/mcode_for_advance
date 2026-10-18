#!/usr/bin/env bash
# 【ARC-006 MERGE-2 第一片】mcode-agent 节点包：纯逻辑单测 +（有真 node-red 时）
# 真引擎注册/部署/执行。未安装 node-red 时真引擎段显式 SKIP（带原因）并以 0 退出。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-node-pack.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

source "$(dirname "$0")/../lib/esbuild-path.sh"

# ① 节点包本体（Node-RED 在引擎进程里 require 的那份，CJS）。
"$ESBUILD" src/main/workflowEngines/mcodeNodePack.ts \
  --bundle --platform=node --format=cjs \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/mcodeNodePack.cjs" --log-level=error

# ② 套件本体（纯逻辑单测 + 真引擎编排）。registry/runtimeSupervisor 的 import 链拖进
#    dataRoot(electron) 与 logger → 换桩。
"$ESBUILD" scripts/mcode-node-pack-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

# 生产注册表的 dataDirOf 会读 <dataRoot>（换桩后指向这里）——只用来算引擎数据目录。
NR_ENGINE_ROOT="${MCODE_NR_E2E_ROOT:-$PWD/.tmp/nr-e2e}"

MCODE_NODE_PACK_TEST_ROOT="$OUT" MCODE_SMOKE_DATA_ROOT="$NR_ENGINE_ROOT" node "$OUT/smoke.mjs"
