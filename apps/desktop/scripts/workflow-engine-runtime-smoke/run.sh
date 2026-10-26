#!/usr/bin/env bash
# 【ARC-006 WF-INT】第三方工作流引擎运行时监管的无头回归（假进程状态机）。
# 不碰磁盘数据、不起 Electron；真 Node-RED 的 NR0 验证见 docs/planning/arc-006-wf-integration.md。
set -euo pipefail
cd "$(dirname "$0")/../.."

# ⚠️ 产物目录必须在 `.tmp/` 下，不能用 `/tmp`。【MC-052】之后本套经 `--external:ssh2`
# 把 ssh2 的 import 留到运行时，由 node **从产物目录往上**找 `node_modules`；`/tmp` 在
# Windows 上不在仓库里，找不到就 `ERR_MODULE_NOT_FOUND: Cannot find package 'ssh2'`。
# `app-control-smoke` / `agent-mail-smoke` 是同一个坑。
mkdir -p .tmp
OUT=$(mktemp -d .tmp/mcode-wf-engine-runtime.XXXXXX)
DATA=$(mktemp -d .tmp/mcode-wf-engine-runtime-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

source "scripts/lib/esbuild-path.sh"

# §8 引入生产注册表（`workflowEngines/registry.ts`）后，它的 import 链会拖进
# `dataRoot.ts` → electron；无头里换桩。桩未设环境变量即抛（防误指真库），
# 所以这里给一个临时数据根；本套不调用任何会读它的方法（statusOf 是只读的）。
mcode_esbuild scripts/workflow-engine-runtime-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/workflowEngines/nodePackProductionPorts.js=./scripts/mcode-node-pack-smoke/productionPortsStub.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --external:sherpa-onnx-node --external:ssh2 \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
