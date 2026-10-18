#!/usr/bin/env bash
# 【ARC-006 WF-INT】第三方工作流引擎运行时监管的无头回归（假进程状态机）。
# 不碰磁盘数据、不起 Electron；真 Node-RED 的 NR0 验证见 docs/planning/arc-006-wf-integration.md。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-wf-engine-runtime.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/workflow-engine-runtime-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
