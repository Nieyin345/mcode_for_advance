#!/usr/bin/env bash
# Headless smoke for the structured-output pipeline (main/lib/structuredOutput.ts).
#
# Everything asserted is pure — no electron, no provider, no filesystem. Covers
# the degradation path shared by Codex / Pi (and Claude behind a custom
# gateway): prompt injection text, JSON extraction (fences / noise / nested
# braces), schema validation over the supported subset, and the combined
# parseStructuredOutput entry.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-structured-output-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/structured-output-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
