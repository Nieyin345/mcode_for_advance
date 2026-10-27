#!/usr/bin/env bash
# 【ARC-006 MERGE-2】节点包：纯逻辑单测 +（有真 node-red 时）真引擎注册/部署/执行。
# 未安装 node-red 时真引擎段显式 SKIP（带原因）并以 0 退出。
#
# ## 并行隔离（与 node-red-e2e-smoke 可同跑）
#
# 本套**不再**把数据根指到 `.tmp/nr-e2e`（那是 node-red-e2e 的安装树，且它在同一
# 目录断言 `engine-trust.json` = untrusted）。两个套件并行时共享该目录会互相踩：
# 本套写入 `{"trusted":true}`，对侧重启断言就红（实测 78/80）。
#
# 现在本套用**自己的 mktemp 数据根**（`MCODE_SMOKE_DATA_ROOT=$DATA`），其中
# `workflow-engines/node-red/node_modules` 由 main.ts 建 **junction** 指向共享安装树
# —— 106MB 的 node-red 不复制，而 `engine-trust.json` / `flows.json` / `bootstrap.cjs`
# / `.engine-admin-token` 全部落在本套的临时目录里，互不干扰。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

# Externals (ssh2) resolve from the generated ESM file; keep it under desktop/node_modules reach.
mkdir -p .tmp
OUT=$(mktemp -d ./.tmp/mcode-node-pack.XXXXXX)
# 本套私有的数据根（并行隔离；junction 在 main.ts 里建）。
DATA=$(mktemp -d /tmp/mcode-node-pack-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

source "$HERE/../lib/esbuild-path.sh"

# Fail early if the shipped child payload is older than its TS entrypoints.
node build/build-node-pack.cjs --check

# ① 节点包本体（Node-RED 在引擎进程里 require 的那份，CJS）。两份：agent 单类型
#    历史入口 + 7 类型总包（C 段用后者）。
"$ESBUILD" src/main/workflowEngines/mcodeNodePack.ts \
  --bundle --platform=node --format=cjs \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/mcodeNodePack.cjs" --log-level=error
"$ESBUILD" src/main/workflowEngines/mcodeNodeTypes.ts \
  --bundle --platform=node --format=cjs \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/mcodeNodeTypes.cjs" --log-level=error

# ② 套件本体（纯逻辑单测 + 真引擎编排）。registry/runtimeSupervisor 的 import 链拖进
#    dataRoot(electron) 与 logger → 换桩。
"$ESBUILD" scripts/mcode-node-pack-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/workflowEngines/nodePackProductionPorts.js=./scripts/mcode-node-pack-smoke/productionPortsStub.ts \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --external:sherpa-onnx-node \
  --external:cpu-features \
  --external:ssh2 \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

# 本套私有的数据根由 run.sh 用 mktemp 建；共享安装树的**位置**通过
# MCODE_NR_E2E_ROOT 传入（main.ts 用它建 junction 的 target）。
NR_ENGINE_ROOT="${MCODE_NR_E2E_ROOT:-$PWD/.tmp/nr-e2e}"

MCODE_NODE_PACK_TEST_ROOT="$OUT" \
MCODE_SMOKE_DATA_ROOT="$DATA" \
MCODE_NODE_PACK_SHARED_ENGINE_ROOT="$NR_ENGINE_ROOT" \
node "$OUT/smoke.mjs"
