#!/usr/bin/env bash
# Headless smoke for 【Office 深度集成】**文件历史**（`main/document/documentHistory.ts`）。
# 见 main.ts 文件头。
#
# ## 它为什么要独立一个 dataRoot
#
# 这一套**真的读写磁盘**（记录/列出/回滚都要落快照）。所以 dataRoot 指向一个
# 临时目录，绝不碰用户的真数据根 —— 这是本仓库的硬规矩（无头验证必须指向副本）。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."

OUT=$(mktemp -d /tmp/mcode-document-history-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-document-history-data.XXXXXX)
WORK=$(mktemp -d /tmp/mcode-document-history-work.XXXXXX)
trap 'rm -rf "$OUT" "$DATA" "$WORK"' EXIT
source "$SCRIPT_DIR/../lib/esbuild-path.sh"

"$ESBUILD" scripts/document-history-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" MCODE_HISTORY_WORK="$WORK" node "$OUT/smoke.mjs"
