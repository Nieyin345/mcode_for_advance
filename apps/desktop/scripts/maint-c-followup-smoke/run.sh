#!/usr/bin/env bash
# MAINT C 组跨任务收尾(M34→M33 / M35→M33 三项)的定向 smoke。
# 复用 library-delete-smoke 的替身与别名(理由见那边 run.sh 头注),数据根为本脚本的临时目录,
# 不碰用户真实资料库;不起 Electron。`electron.shell.openPath` 换成**记名**替身,本套要断言
# 「打开」最终落到哪个路径。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-maint-cf-smoke.XXXXXX)
ln -s "$PWD/node_modules" "$OUT/node_modules"
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/maint-c-followup-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --external:pdfjs-dist \
  --alias:electron=./scripts/maint-c-followup-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/db-migrate-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/library-delete-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/library-delete-smoke/stubs/runtimeManager.ts \
  --alias:@main/browser/BrowserManager.js=./scripts/library-delete-smoke/stubs/browserManager.ts \
  --alias:@main/workflows/seed.js=./scripts/library-delete-smoke/stubs/workflowsSeed.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
