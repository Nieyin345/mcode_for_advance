#!/usr/bin/env bash
# Code-only regression suite for Mcode branch edge metadata/context propagation.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d /tmp/mcode-branch-context-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

source "$HERE/../lib/esbuild-path.sh"
"$ESBUILD" "$HERE/main.ts" \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
