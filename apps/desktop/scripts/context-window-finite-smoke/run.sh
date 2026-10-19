#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/lib/esbuild-path.sh
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/context-window-finite-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --alias:@renderer/lib/i18n/core.js=./scripts/context-window-finite-smoke/stubI18n.ts --alias:@renderer/stores/sessionStore.js=./scripts/context-window-finite-smoke/stubSession.ts --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
