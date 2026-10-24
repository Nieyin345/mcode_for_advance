#!/usr/bin/env bash
# Headless smoke for **Repository 层的导出契约**（拆分之后不许少一个）。
# 见 main.ts 文件头。数据根换成临时目录 —— 它 import 了真的 db.ts。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d /tmp/mcode-repositories-barrel.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-repositories-barrel-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

source "$HERE/../lib/esbuild-path.sh"

"$ESBUILD" scripts/repositories-barrel-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/repositories-barrel-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/repositories-barrel-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/repositories-barrel-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"
node "$OUT/smoke.mjs"
