#!/usr/bin/env bash
# walkCache 的独占套件 —— `main/lib/walkCache.ts` 此前**一套覆盖都没有**。
#
# 它是纯件(只 import node:fs / node:path),没有主进程依赖,所以不需要任何 --alias。
# 真建临时目录树、真调 `cachedTreeFiles`,断言缓存/失效/预算三条链。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-walk-cache-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/walk-cache-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
