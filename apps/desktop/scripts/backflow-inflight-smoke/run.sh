#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../.."
source "$HERE/../lib/esbuild-path.sh"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/mcode-backflow-inflight.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/backflow-inflight-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
