#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/lib/esbuild-path.sh
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/session-sync-transport-fault-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --alias:@main/window.js=./scripts/session-sync-transport-fault-smoke/stubWindow.ts --alias:@main/mobile/MobileEventBus.js=./scripts/session-sync-transport-fault-smoke/stubMobile.ts --alias:@contracts/ipc=./scripts/session-sync-transport-fault-smoke/stubIpc.ts --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
