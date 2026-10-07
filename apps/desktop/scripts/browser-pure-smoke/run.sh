#!/usr/bin/env bash
# `browserPure.ts`(从 BrowserManager 抽出的无头纯函数)的回归网。
# 纯件只 import node:fs/node:path 与 contracts 的 type,不碰 electron,故无需换桩。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-browser-pure.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/browser-pure-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
