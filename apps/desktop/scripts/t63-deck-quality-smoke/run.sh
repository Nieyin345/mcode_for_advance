#!/usr/bin/env bash
# T63 —— PPT 产出质量的回归断言（真 GenOffice CLI、真子进程、真文件）。
#
# 只跑局部：本套件不碰 Electron、不跑其它套件。
# 全部夹具在 mktemp 的隔离 workspace 里，经 `create --spec` 同一条 builder 路径造出来。
#
# 变异验证：`--mutate=<name>` 见 main.ts 的对应分支（若未实现则该参数无效）。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."

OUT=$(mktemp -d /tmp/mcode-t63-quality.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-t63-quality-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$SCRIPT_DIR/../lib/esbuild-path.sh"

"$ESBUILD" scripts/t63-deck-quality-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
