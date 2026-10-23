#!/usr/bin/env bash
# T27 · 生产装载入口 `loadWorkflowIntoNative` 不再拒绝一切可保存的 Node-RED 图。
#
# 本套驱动的是**生产函数**（`ipc/index.ts` 的 `workflowEngine.load` 端口就是它）：
#   - 普通 trigger 工作流 / 含 Mcode 特有节点的图：已知损失只升「一次确认」，确认后装载；
#   - 未知节点类型（预检 REJECT）：无论确认与否都拒绝，理由可读；
#   - T21 的审批/在途判据原样保留；
#   - 真 `node-red@5.0.8` 引擎把生产装载写出的画布启动并 `GET /flows` 读回。
#
# 隔离：`MCODE_SMOKE_DATA_ROOT` 是本套私有的 mktemp 数据根（sql.js 会重写整份
# mcode.db —— 指到真库等于毁数据）；不起 Electron；vendor 缺失时真引擎段显式 SKIP。
set -euo pipefail
cd "$(dirname "$0")/../.."     # → apps/desktop

# 产物落在仓库内 `.tmp/`：registry / runtimeSupervisor 的 import 链要按**产物位置**
# 解析 `--external:` 的依赖（与 node-red-deploy-reconciliation-smoke 同一取舍）。
mkdir -p .tmp
OUT=$(mktemp -d ./.tmp/mcode-t27-deadlock.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-t27-deadlock-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source scripts/lib/esbuild-path.sh

"$ESBUILD" scripts/t27-load-entry-deadlock-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/workflowEngines/nodePackProductionPorts.js=./scripts/mcode-node-pack-smoke/productionPortsStub.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/mcode-admin-smoke/stubs/pluginManager.ts \
  --external:sherpa-onnx-node --external:ssh2 \
  --alias:electron=./scripts/mobile-pairing-smoke/stubs/electron.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
