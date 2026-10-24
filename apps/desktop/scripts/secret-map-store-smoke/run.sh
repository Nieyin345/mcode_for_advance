#!/usr/bin/env bash
# Headless smoke for **凭据映射存储** —— `main/lib/secretMapStore.ts` 及其三个消费方
# （secretStore / piModelsStore / codexModelsStore）。见 main.ts 文件头。
#
# ## 换栈清单（都不是被验代码）
#   - `electron`                        → 桩（secretStore 顶层 import safeStorage）
#   - `@main/store/repositories.js`     → 内存表 + `__putRaw`（真那份是 sql.js，会毁真库）
#   - `@main/lib/logger.js`             → **记录型**桩（本套的核心判据读它）
#   - `@main/lib/secretStore.js`        → 可逆桩（真那份走 safeStorage）
#
# ⚠️ logger 那份必须是"记录"而不是"打印到 stderr 就算"：本套断言的是
#    **坏数据有没有被上报**，判据读的就是 log.error 的调用。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d /tmp/mcode-secret-map-store.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

source "$HERE/../lib/esbuild-path.sh"

"$ESBUILD" scripts/secret-map-store-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/secret-map-store-smoke/stubs/electron.ts \
  --alias:@main/store/repositories.js=./scripts/secret-map-store-smoke/stubs/repositories.ts \
  --alias:@main/lib/logger.js=./scripts/secret-map-store-smoke/stubs/logger.ts \
  --alias:@main/lib/secretStore.js=./scripts/secret-map-store-smoke/stubs/secretStore.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
