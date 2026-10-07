#!/usr/bin/env bash
# Reliable SSH / detached remote-job smoke.
set -euo pipefail
cd "$(dirname "$0")/../.."

mkdir -p ./.tmp/remote-ssh-smoke
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/remote-ssh-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --packages=external --tsconfig=tsconfig.json \
  --outfile=./.tmp/remote-ssh-smoke/smoke.mjs --log-level=error

node ./.tmp/remote-ssh-smoke/smoke.mjs
