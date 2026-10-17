#!/usr/bin/env bash
# Headless smoke for ARC-007 逐格式门（G1 打开不重写 / G2 编辑往返 / G3 路由拒绝面 /
# G4 写路径围栏 / G5 dry-run 语义 / 反向正控）。真 GenOffice CLI、真子进程、真文件。
#
# 被测：src/main/document/genofficeCli.ts（docsRead/docsApply/slidesRead/sheetRead/
# convertFile）与 src/main/ipc/document.ts 的 readByKind 路由。
# CLI bundle 不存在时整套显式 SKIP（与 genoffice-cli-smoke 一致）。
# 不碰 db / sql.js；但因 readByKind 的动态导入链会经 pathGuard 拉进 store，
# 照例挂 logger/dataRoot 桩并给临时数据根。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-genoffice-gates-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-genoffice-gates-smoke-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/genoffice-format-gates-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
