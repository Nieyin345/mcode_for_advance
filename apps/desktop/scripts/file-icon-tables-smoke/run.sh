#!/usr/bin/env bash
# Headless smoke for **图标表的显式清单**（`fileIconTables.ts` 的
# REFERENCED_ICON_NAMES 必须与表里实际取值一致）。见 main.ts 文件头。
# `fileIconTables.ts` 是纯数据、不 import 任何东西，打包后直接 node 跑。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-file-icon-tables.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/file-icon-tables-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
