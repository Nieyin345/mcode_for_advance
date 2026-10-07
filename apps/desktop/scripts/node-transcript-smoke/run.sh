#!/usr/bin/env bash
# Headless smoke for the workflow-node transcript folding
# (`main/claude/nodeTranscript.ts` — 「看这一步的过程」的唯一一处逻辑).
#
# No stubs: the module under test imports types only (no electron, no fs, no
# SDK), so nothing needs replacing. See main.ts's header for what is and is not
# covered.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-node-transcript-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/node-transcript-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
