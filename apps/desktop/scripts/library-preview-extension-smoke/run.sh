#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/lib/esbuild-path.sh
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/library-preview-extension-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --alias:@renderer/stores/libraryStore.js=./scripts/library-preview-extension-smoke/stubLibrary.ts --alias:@renderer/stores/sessionStore.js=./scripts/library-preview-extension-smoke/stubSession.ts --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
