#!/usr/bin/env bash
# Headless smoke for md 预览里的图片围栏 —— `file:readBinary` 认不认**数据根**下的路径。
#
# 为什么要它：`FileViewer` 预览 md 时图片走 `file.readBinary`，而那条 IPC 有项目根
# 围栏。资料库里 md 的相对图片在**数据根**下 —— 能不能显示全看围栏认不认。
# 这条链以前从没被走到过（`FileViewer` 原本压根没传 `baseDir`），所以没人测。
#
# ⚠️ 数据根换成自己的临时目录（复用 db-migrate-smoke 的 dataRoot/logger 桩），
# 跑完就删，绝不碰用户真数据根。
#
# 别名与 library-entry-path-smoke **逐档一致** —— 理由见那一份 run.sh 的长注释
# （electron 整个包 / window / RuntimeManager / BrowserManager / library-http /
# workflows-seed，其中 workflows/seed 非有不可，否则 esbuild 撞上 `.py` 的 loader）。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-mdimg-guard.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-mdimg-data.XXXXXX)
ln -s "$PWD/node_modules" "$OUT/node_modules"
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/md-image-guard-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/db-migrate-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/fixtures/library-stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/fixtures/library-stubs/runtimeManager.ts \
  --alias:@main/browser/BrowserManager.js=./scripts/fixtures/library-stubs/browserManager.ts \
  --alias:@main/workflows/seed.js=./scripts/library-delete-smoke/stubs/workflowsSeed.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
