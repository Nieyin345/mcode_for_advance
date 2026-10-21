#!/usr/bin/env bash
# 【ARC-006 WF-INT】第三方工作流引擎运行时监管的无头回归（假进程状态机）。
# 不碰磁盘数据、不起 Electron；真 Node-RED 的 NR0 验证见 docs/planning/arc-006-wf-integration.md。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-wf-engine-runtime.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-wf-engine-runtime-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# §8 引入生产注册表（`workflowEngines/registry.ts`）后，它的 import 链会拖进
# `dataRoot.ts` → electron；无头里换桩。桩未设环境变量即抛（防误指真库），
# 所以这里给一个临时数据根；本套不调用任何会读它的方法（statusOf 是只读的）。
"$ESBUILD" scripts/workflow-engine-runtime-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/workflowEngines/nodePackProductionPorts.js=./scripts/mcode-node-pack-smoke/productionPortsStub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
