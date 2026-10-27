#!/usr/bin/env bash
# 【Q8/Q9e】引擎按需启动的判据回归（假 EngineRuntime，不 spawn 子进程、不碰磁盘）。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d .tmp/mcode-engine-autostart.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

source "$HERE/../lib/esbuild-path.sh"

# `engineAutostart` 会 import `ipc/workflowEngine`（真身，不换桩 —— 那才是被测的
# 调用路径）；那条链把 dataRoot（electron）与 logger 带进来，无头里换桩。
# ⚠️ 数据根必须指临时目录：`dataRoot` 桩没设环境变量就抛。
DATA=$(mktemp -d .tmp/mcode-engine-autostart-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

mcode_esbuild scripts/engine-autostart-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --external:sherpa-onnx-node --external:ssh2 \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
