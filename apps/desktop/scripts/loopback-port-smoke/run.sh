#!/usr/bin/env bash
# Headless smoke for loopback port allocation (lib/loopbackPort.ts).
#
# Bundles scripts/loopback-port-smoke/main.ts with esbuild (tsconfig paths
# apply, so @main/* resolves). Pure local sockets, no electron and no network.
# See main.ts for the covered scenarios.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-loopback-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/loopback-port-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/logger.js=./scripts/upstream-headers-smoke/stub-logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
