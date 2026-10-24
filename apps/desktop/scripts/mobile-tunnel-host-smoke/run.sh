#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
OUT=$(mktemp -d /tmp/mcode-mobile-tunnel-host.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"
"$ESBUILD" scripts/mobile-tunnel-host-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:@main/store/repositories.js=./scripts/mobile-tunnel-host-smoke/stubs.ts \
  --alias:@main/store/db.js=./scripts/mobile-tunnel-host-smoke/stubs.ts \
  --alias:@main/lib/secretStore.js=./scripts/mobile-tunnel-host-smoke/stubs.ts \
  --alias:@main/lib/logger.js=./scripts/mobile-tunnel-host-smoke/stubs.ts \
  --alias:@main/providers/bridge/tunnelManager.js=./scripts/mobile-tunnel-host-smoke/stubs.ts \
  --alias:@main/mobile/MobileHttpServer.js=./scripts/mobile-tunnel-host-smoke/stubs.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
