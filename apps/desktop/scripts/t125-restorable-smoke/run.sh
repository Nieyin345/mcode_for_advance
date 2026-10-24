#!/usr/bin/env bash
# 【T125】不可还原的产物：restorable 状态与数据安全。
#
# 无头：真 FileSnapshot + 真 restoreFiles，不起 Electron、不连数据库。
# 全部文件操作在 mktemp 目录里，退出即删。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d ./.tmp/mcode-t125-restorable.XXXXXX)
DATA=$(mktemp -d ./.tmp/mcode-t125-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "./scripts/lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then
  echo "Existing esbuild dependency not found; refusing network fallback." >&2
  exit 127
fi

"$ESBUILD" scripts/t125-restorable-smoke/main.ts \
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
