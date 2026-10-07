#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-openai-reasoning.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "Existing esbuild required; no network fallback." >&2; exit 127; fi
"$ESBUILD" scripts/openai-reasoning-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:@main/lib/logger.js=./scripts/extension-bridge-smoke/stub-logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
