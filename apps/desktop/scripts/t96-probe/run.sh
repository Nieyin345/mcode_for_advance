#!/usr/bin/env bash
# T96 探针：**迁移后的 mcode-* 节点在真 Node-RED 5.0.8 里会被执行吗？**
#
# 与 `node-red-e2e-smoke` 的分工：
#   - e2e 证明「含 mcode-* 的整组 flow 能启动」（`★【T42】` 那条 HTTP-in 200）；
#   - **本套证明「mcode-agent 的 execute 真跑了、真调到了 Host、结果回灌到下游」**。
# e2e 那条 200 是一个**纯原生节点**给的，跟 mcode-agent 是否执行无关。
#
# 未安装 node-red 时显式 SKIP 并以 0 退出（与 e2e 同一条规矩：无网机器上全量不能红）。
# 安装位置同 e2e：`apps/desktop/.tmp/nr-e2e/`（`MCODE_NR_E2E_ROOT` 可覆盖）。
#
# ## 并行隔离
# 私有 mktemp 数据根 + `node_modules` junction 指回共享安装树（106MB 不复制），
# 与 `mcode-node-pack-smoke` / `node-red-e2e-smoke` 同一种做法。
set -euo pipefail
cd "$(dirname "$0")/../.."

mkdir -p .tmp
OUT=$(mktemp -d ./.tmp/t96-probe.XXXXXX)
DATA=$(mktemp -d "${TMPDIR:-/tmp}/mcode-t96-data.XXXXXX")
trap 'rm -rf "$OUT" "$DATA"' EXIT

source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/t96-probe/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/workflowEngines/nodePackProductionPorts.js=./scripts/mcode-node-pack-smoke/productionPortsStub.ts \
  --external:sherpa-onnx-node \
  --outfile="$OUT/probe.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" \
MCODE_NR_E2E_ROOT="${MCODE_NR_E2E_ROOT:-$PWD/.tmp/nr-e2e}" \
node "$OUT/probe.mjs"
