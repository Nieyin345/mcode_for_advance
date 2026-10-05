#!/usr/bin/env bash
# Isolated HOME, mocked HTTP, clone forbidden; no user data or network.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-skill-lazy-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/skill-lazy-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/store/repositories.js=./scripts/market-smoke/stubs/repositories.ts \
  --alias:@main/lib/marketClone.js=./scripts/skill-lazy-smoke/cloneGuard.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

SMOKE_HOME="$OUT/home"
mkdir -p "$SMOKE_HOME"
SKILL_LAZY_TEST_HOME="$SMOKE_HOME" HOME="$SMOKE_HOME" USERPROFILE="$SMOKE_HOME" node "$OUT/smoke.mjs"
