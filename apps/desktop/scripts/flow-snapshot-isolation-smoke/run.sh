#!/usr/bin/env bash
# ARC-006: pure in-memory migration, no user files or external processes.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-flow-snapshot.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "scripts/lib/esbuild-path.sh"
mcode_esbuild scripts/flow-snapshot-isolation-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
