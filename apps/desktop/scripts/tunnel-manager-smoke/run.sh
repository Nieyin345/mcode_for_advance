#!/usr/bin/env bash
# Headless smoke for the public-MCP tunnel manager
# (`main/providers/bridge/tunnelManager.ts`).
#
# No real process, no network: `main.ts` injects a fake spawn and feeds captured
# cloudflared output (the pre-check block + the "quick Tunnel has been created"
# line) to assert the domain extraction — the one thing that's actually easy to
# get wrong. See main.ts for the covered scenarios.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-tunnel-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/tunnel-manager-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/logger.js=./scripts/tunnel-manager-smoke/stub-logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
