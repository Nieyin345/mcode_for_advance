#!/usr/bin/env bash
# Headless smoke for the engine-agnostic turn-incomplete check (MC-009).
# 三个适配器都可无头实例化（只 import 契约包 + fileSnapshot / 纯 fs）。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d /tmp/mcode-turn-incomplete-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

source "$HERE/../lib/esbuild-path.sh"

"$ESBUILD" scripts/turn-incomplete-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
