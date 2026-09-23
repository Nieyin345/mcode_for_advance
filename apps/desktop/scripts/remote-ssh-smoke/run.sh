#!/usr/bin/env bash
# Reliable SSH / detached remote-job smoke.
set -euo pipefail
cd "$(dirname "$0")/../.."

mkdir -p ./.tmp/remote-ssh-smoke
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/remote-ssh-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --packages=external --tsconfig=tsconfig.json \
  --outfile=./.tmp/remote-ssh-smoke/smoke.mjs --log-level=error

node ./.tmp/remote-ssh-smoke/smoke.mjs
