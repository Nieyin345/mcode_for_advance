#!/usr/bin/env bash
# Headless smoke for **类型层的转发面**（搬到 sessionStoreTypes.ts 之后不许少一个）。
# 它只读两个源文件，不起 node 运行时依赖，所以不需要换桩。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d /tmp/mcode-session-store-types.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

source "$HERE/../lib/esbuild-path.sh"

"$ESBUILD" scripts/session-store-types-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
