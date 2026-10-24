#!/usr/bin/env bash
# preset-scripts-sync-smoke —— 【MC-008】预设里的 Python 正文只能来自 assets.ts。
#
# 判据：磁盘预设 == 生成结果（手改 JSON 会红）、每个目标的正文逐字节等于权威常量、
# 没有未受管的 Python、seed 落盘清单与预设引用对齐（真跑 ensureWorkflows 看盘上）。
# 生成逻辑与 `scripts/preset-scripts-sync/` 共用 `scripts/lib/presetCodegen.ts`。
#
# 数据根换成 mktemp 目录（复用 run-store-smoke 的 dataRoot/logger 桩）——
# `ensureWorkflows` 会往 `<数据根>/workflows/` 真写文件，绝不碰用户真库。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d /tmp/mcode-preset-sync-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-preset-sync-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

source "$HERE/../lib/esbuild-path.sh"

"$ESBUILD" scripts/preset-scripts-sync-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"
node "$OUT/smoke.mjs"
