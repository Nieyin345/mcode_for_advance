#!/usr/bin/env bash
# 【T123】Office 产物必须进 turn.files，否则任务中心看不见它们。
#
# 无头：真 FileSnapshot + 真 SdkMessageAdapter + 真 classifyTurn，不起 Electron、
# 不连数据库、不调 genoffice CLI（`.docx` 用最小字节样本，判据在 freeze/classify 上）。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d ./.tmp/mcode-t123-office.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "./scripts/lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then
  echo "Existing esbuild dependency not found; refusing network fallback." >&2
  exit 127
fi

"$ESBUILD" scripts/t123-office-artifact-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/claude/RuntimeManager.js=./scripts/task-message-auto-create-smoke/stubs/runtimeManager.ts \
  --alias:@main/window.js=./scripts/app-control-smoke/stubs/window.ts \
  --alias:@main/mobile/MobileEventBus.js=./scripts/task-message-auto-create-smoke/stubs/mobileEventBus.ts \
  --alias:@main/lib/dataRoot.js=./scripts/task-message-auto-create-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$OUT/data" node "$OUT/smoke.mjs"
