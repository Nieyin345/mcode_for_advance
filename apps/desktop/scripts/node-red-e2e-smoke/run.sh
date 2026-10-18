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
# 与 logger（electron 日志目录）；无头里换桩。桩未设 MCODE_SMOKE_DATA_ROOT 即抛，
# 这里把它指向 node-red 的安装根 —— 生产注册表的 launchSpec 只写 bootstrap.cjs 与
# .engine-secret 到 <dataRoot>/workflow-engines/node-red/，与 main.ts 的前置检查同一位置。
E2E_ROOT="${MCODE_NR_E2E_ROOT:-$PWD/.tmp/nr-e2e}"
mkdir -p "$E2E_ROOT"
export MCODE_SMOKE_DATA_ROOT="$E2E_ROOT"
export MCODE_NR_E2E_ROOT="$E2E_ROOT"

"$ESBUILD" scripts/node-red-e2e-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
