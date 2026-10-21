#!/usr/bin/env bash
# 【ARC-006 WF-INT · 桥 1】Node-RED 触发执行器无头回归。
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-wf-bridge.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "scripts/lib/esbuild-path.sh"
mcode_esbuild scripts/workflow-engine-bridge-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
