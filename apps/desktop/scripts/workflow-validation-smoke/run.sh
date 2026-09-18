#!/usr/bin/env bash
# Headless smoke for the workflow quality gate (WF-05 schema / WF-08 import-export /
# WF-09 validation report, plan v2 G7 / Phase 4).
#
# Bundles scripts/workflow-validation-smoke/main.ts with esbuild (tsconfig paths
# apply) and runs it in plain node. The module under test is a pure function
# module: no electron, no DB, no fs — the node-type catalog is injected as a
# fixture map, which is exactly how the main process injects loadNodeTypes().
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-wfvalidation-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/workflow-validation-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
