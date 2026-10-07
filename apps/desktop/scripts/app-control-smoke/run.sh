#!/usr/bin/env bash
# Headless smoke for mcode-app(本地 agent 控制 Mcode 的工具组)。esbuild 打包 + node 直跑,不进 Electron。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-app-control-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/app-control-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/window.js=./scripts/app-control-smoke/stubs/window.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --external:electron \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
