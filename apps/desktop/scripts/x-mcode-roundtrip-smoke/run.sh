#!/usr/bin/env bash
# T28 —— x-mcode 导出/导入往返回归。
#
# 无头：把**真上游** editor-client 的 nodes.js 装进 vm 跑导出/导入（不需要 Electron，
# 也不需要起 Node-RED 引擎）。真 Electron 手势级往返在 T8 的 U1 旅程里另有一步。
#
# 仓库没有 vendor Node-RED（node-red/ 目录）时，真上游段显式 SKIP（main.ts 里打印
# 原因并以 0 退出），源码级声明契约段仍然执行 —— 不是假绿。
set -euo pipefail
cd "$(dirname "$0")/../.."

mkdir -p .tmp
OUT=$(mktemp -d ./.tmp/x-mcode-roundtrip.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-x-mcode-roundtrip-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

source "$(dirname "$0")/../lib/esbuild-path.sh"

# flowMigration / builtinManifestById 的 import 链会碰 dataRoot(electron) 与 logger；
# 本套件只做纯逻辑与 vm 往返，按仓库惯例换桩。
mcode_esbuild scripts/x-mcode-roundtrip-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --external:sherpa-onnx-node \
  --external:cpu-features \
  --external:ssh2 \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" \
MCODE_T28_REPO="$(cd ../.. && pwd)" \
node "$OUT/smoke.mjs"
