#!/usr/bin/env bash
# 【ARC-006 NR3】真 Node-RED 5.0.8 引擎的端到端回归：
# 生产 EngineRuntime + 生产注册表 bootstrap 形状 → Admin API 部署流 → 生产
# nodeRedExecutor/defaultNodeRedFetch 打 HTTP-in → 返回值回灌 + 失败分类。
#
# node-red 未安装时本套**显式 SKIP（带原因）并 0 退出** —— 全量套件在无网机器上不能红。
# 安装位置默认 apps/desktop/.tmp/nr-e2e/（gitignored），可用 MCODE_NR_E2E_ROOT 覆盖。
#
# 需要：已安装 node-red@5.0.8（见 main.ts 文件头的安装命令）。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-nr-e2e-smoke.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

source "$(dirname "$0")/../lib/esbuild-path.sh"

# registry.ts / runtimeSupervisor.ts 的 import 链会拖进 dataRoot（electron app.getPath）
# 与 logger（electron 日志目录）；无头里换桩。dataRoot 桩把 MCODE_SMOKE_DATA_ROOT 当
# 数据根本身，所以这里必须给它**本套私有的**临时目录 —— 从前指向 node-red 安装根
# （`.tmp/nr-e2e`），与另一份全量跑 / mcode-node-pack-smoke 同目录并行时互相踩：
# flows.json 被对方清掉、信任标记被改写、Node-RED flush 时目录消失 → 未捕获退出
# （实测并行 78/80 + EADDRNOTAVAIL）。main.ts 在私有数据根里给 node_modules 建
# junction 指回共享安装树，不动也不复制那 106MB。
E2E_ROOT="${MCODE_NR_E2E_ROOT:-$PWD/.tmp/nr-e2e}"
mkdir -p "$E2E_ROOT"
DATA=$(mktemp -d "${TMPDIR:-/tmp}/mcode-nr-e2e-data.XXXXXX")
trap 'rm -rf "$OUT" "$DATA"' EXIT
export MCODE_SMOKE_DATA_ROOT="$DATA"
export MCODE_NR_E2E_ROOT="$E2E_ROOT"

"$ESBUILD" scripts/node-red-e2e-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"

# T19: when a verified vendor release stage is available, also run the real
# production registry against that stage (npm fallback absent), checking the
# editor HTTP page, version, adminAuth and owner handshake. A no-vendor CI run
# is explicitly reported as unverified, not silently counted as a vendor pass.
if [[ -f ".tmp/node-red-release/manifest.json" ]]; then
  "$ESBUILD" scripts/node-red-e2e-smoke/vendor.ts \
    --bundle --platform=node --format=esm \
    --tsconfig=tsconfig.json \
    --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
    --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
    --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
    --outfile="$OUT/vendor.mjs" --log-level=error
  node "$OUT/vendor.mjs"
else
  echo "SKIP: T19 real vendor editor verification (release stage missing)"
fi
