#!/usr/bin/env bash
# Headless smoke for 【MC-008】同一份 Python 的两个副本必须逐字相同。
# `assets.ts` 是纯字面量（不 import 任何东西），打包后直接 node 跑。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-shipped-script-copies.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/shipped-script-copies-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
