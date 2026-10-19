#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-gesture-runtime.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
ESBUILD=$(find ../../node_modules/.pnpm -path "*/esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
"${ESBUILD:-npx esbuild}" scripts/arc005-gesture-runtime-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:react=./scripts/arc005-gesture-runtime-smoke/stubs/react.ts \
  --alias:@renderer/stores/sessionStore.js=./scripts/arc005-gesture-runtime-smoke/stubs/sessionStore.ts \
  --alias:@renderer/lib/commands.js=./scripts/arc005-gesture-runtime-smoke/stubs/commands.ts \
  --alias:@renderer/lib/i18n/core.js=./scripts/arc005-gesture-runtime-smoke/stubs/i18n.ts \
  --alias:@renderer/lib/gestureTrail.js=./scripts/arc005-gesture-runtime-smoke/stubs/gestureTrail.ts \
  --alias:@renderer/lib/platform.js=./scripts/arc005-gesture-runtime-smoke/stubs/platform.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
