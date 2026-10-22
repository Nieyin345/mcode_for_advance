#!/usr/bin/env bash
# T2 · Node-RED 原生 Deploy ↔ Mcode 工作流库对账恢复（无头 E1；不起 Electron、不碰用户库）。
#
# 本套只写自己的 mktemp 数据根（`MCODE_SMOKE_DATA_ROOT`，桩里没设就抛）。落盘账本
# `deploy-reconciliation.json` 与伪造的 `flows.json` 都在 `<dataRoot>/workflow-engines/node-red/`。
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p .tmp
OUT=$(mktemp -d ./.tmp/mcode-deploy-reconciliation.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-deploy-reconciliation-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source scripts/lib/esbuild-path.sh

# registry.ts 的 import 链拖进 dataRoot/logger（electron）与 nodePackProductionPorts
# （RuntimeManager → 三家引擎）；与 executor-gate-d-smoke 用同一组换桩。
"$ESBUILD" scripts/node-red-deploy-reconciliation-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/workflowEngines/nodePackProductionPorts.js=./scripts/mcode-node-pack-smoke/productionPortsStub.ts \
  --external:sherpa-onnx-node --external:ssh2 \
  --alias:electron=./scripts/mobile-pairing-smoke/stubs/electron.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
