#!/usr/bin/env bash
# O1：三家引擎各自驱动 Docs AI 选区编辑（真 docsAiPorts + 三家真适配器/工具粘合）。
#
# 无头：不起 Electron、不联网、不需要 API 凭据。替身只扮演各家 SDK 的**消息流**
# （scripts/o1-three-provider-ai-smoke/shapes/）与宿主仓储/窗口
# （scripts/o1-three-provider-ai-smoke/stubs/harnessEnv.ts）。
#
# ⚠️ `@main/lib/dataRoot.js` 的桩没设 MCODE_SMOKE_DATA_ROOT 就抛 —— 不回落默认值，
# 免得指错就拿空库盖掉用户数据（见 run-store-smoke/stubs/dataRoot.ts 文件头）。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/lib/office-coverage.mjs o1
if [ "${1:-}" = "--coverage-only" ]; then exit 0; fi

OUT=$(mktemp -d ./.tmp/mcode-o1-three-provider.XXXXXX)
DATA=$(mktemp -d ./.tmp/mcode-o1-three-provider-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

source "./scripts/lib/esbuild-path.sh"
if [[ -z "${ESBUILD:-}" ]]; then
  echo "esbuild 没找到；不回落 npx（那会联网）。" >&2
  exit 127
fi

HARNESS=./scripts/o1-three-provider-ai-smoke/stubs/harnessEnv.ts
LOGGER=./scripts/run-store-smoke/stubs/logger.ts
DATAROOT=./scripts/run-store-smoke/stubs/dataRoot.ts

"$ESBUILD" scripts/o1-three-provider-ai-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/claude/RuntimeManager.js="$HARNESS" \
  --alias:@main/store/repositories.js="$HARNESS" \
  --alias:@main/providers/registry.js="$HARNESS" \
  --alias:@main/lib/pathGuard.js="$HARNESS" \
  --alias:@main/window.js="$HARNESS" \
  --alias:electron="$HARNESS" \
  --alias:@main/lib/dataRoot.js="$DATAROOT" \
  --alias:@main/lib/logger.js="$LOGGER" \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
