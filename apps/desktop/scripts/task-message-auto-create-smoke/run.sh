#!/usr/bin/env bash
# 【T100】消息 → 任务：回合产出文件就自动记成一条任务。
#
# ⚠️ 这一套**真建库**（sql.js 会重写整个 mcode.db）。数据根必须是 mktemp 目录：
# 指错地方等于拿空库盖掉用户的聊天记录。stubs/dataRoot.ts 那句「没设就抛」就是
# 为这件事 —— 别去改它。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."

OUT=$(mktemp -d /tmp/mcode-task-auto-create.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-task-auto-create-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$SCRIPT_DIR/../lib/esbuild-path.sh"

"$ESBUILD" scripts/task-message-auto-create-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/task-message-auto-create-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/task-message-auto-create-smoke/stubs/runtimeManager.ts \
  --alias:@main/window.js=./scripts/app-control-smoke/stubs/window.ts \
  --alias:@main/mobile/MobileEventBus.js=./scripts/task-message-auto-create-smoke/stubs/mobileEventBus.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
