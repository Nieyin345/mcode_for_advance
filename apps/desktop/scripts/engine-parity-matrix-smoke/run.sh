#!/usr/bin/env bash
# T08: pure helper execution + traced production source, no Electron/SDK or user data.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p .tmp
OUT=$(mktemp -d ./.tmp/engine-parity-matrix.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "${ESBUILD:-}" ]]; then echo "esbuild not found" >&2; exit 1; fi
ALIAS_ARGS=()
if [[ -n "${T08_CONTEXT_MUTATION_FILE:-}" ]]; then
  # Test-only isolated replacement. Never modify main/providers/contextPrompt.ts.
  ALIAS_ARGS=("--alias:@main/providers/contextPrompt.js=${T08_CONTEXT_MUTATION_FILE}")
fi
"$ESBUILD" scripts/engine-parity-matrix-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  "${ALIAS_ARGS[@]}" --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
