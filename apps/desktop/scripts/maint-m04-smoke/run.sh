#!/usr/bin/env bash
# Isolated regression for Pi plan-mode approval precedence.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-maint-m04.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then
  echo "Existing esbuild dependency not found; refusing network fallback." >&2
  exit 127
fi

"$ESBUILD" scripts/maint-m04-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
