#!/usr/bin/env bash
# Headless smoke for the browser-extension bridge.
#
# Bundles scripts/extension-bridge-smoke/main.ts with esbuild (tsconfig paths
# apply, so @main/* and @contracts/* resolve). No electron and no browser: main.ts
# plays the role of the extension and talks to the real bridge server over real
# HTTP on 127.0.0.1. See main.ts for the covered scenarios.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-ext-bridge-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/extension-bridge-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/logger.js=./scripts/extension-bridge-smoke/stub-logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"