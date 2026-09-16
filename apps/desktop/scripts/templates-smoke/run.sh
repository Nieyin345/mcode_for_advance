#!/usr/bin/env bash
# Headless smoke for 模版文件的读取(`main/templates/read.ts`)—— 见 main.ts 文件头。
#
# 真的建目录、真的放夹具、真的读 —— 只是脚下那个数据根换成临时目录(见
# stubs/dataRoot.ts 里那句"没设就抛":指错地方就是拿夹具盖掉用户的模版库)。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-templates-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-templates-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# 那三个模块 import 了 electron,换掉(见 stubs/)。被测的那份代码一行都没改。
# `@main/window.js` 也要换 —— `templates/store.ts` 从它引了 `sendToRenderer`。
"$ESBUILD" scripts/templates-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/dataRoot.js=./scripts/templates-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/templates-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/templates-smoke/stubs/window.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" \
MCODE_SMOKE_FIXTURES="$PWD/scripts/templates-smoke/fixtures" \
  node "$OUT/smoke.mjs"
