#!/usr/bin/env bash
# MAINT M28:runner 的续跑/重试与"启动中"竞态、启动失败不得静默。
# 复用 node-session-smoke 的替身与夹具(只读),只换 providerRegistry 桩(本套要能让引擎预检
# 挂起 / 失败)。数据根为临时目录;不起 Electron、不碰真实模型与真实数据库。
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-maint-m28-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-maint-m28-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [ -z "$ESBUILD" ]; then ESBUILD="npx esbuild"; fi
"$ESBUILD" scripts/maint-m28-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --external:@renderer/lib/monacoSetup.js \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/node-session-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/node-session-smoke/stubs/logger.ts \
  --alias:electron=./scripts/node-session-smoke/stubs/electron.ts \
  --alias:@main/window.js=./scripts/node-session-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/node-session-smoke/stubs/runtimeManager.ts \
  --alias:@main/providers/registry.js=./scripts/maint-m28-smoke/stubs/providerRegistry.ts \
  --alias:@main/workflows/seed.js=./scripts/node-session-smoke/stubs/workflowsSeed.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/node-session-smoke/stubs/pluginManager.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
