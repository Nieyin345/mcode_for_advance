#!/usr/bin/env bash
# M20: headless, fake audio + in-memory RPC/settings + blocked network.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-maint-m20.XXXXXX")
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo 'Local esbuild is required (no network installs)' >&2; exit 2; fi
"$ESBUILD" scripts/maint-m20-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:electron=./scripts/maint-m20-smoke/stubs/electron.ts \
  --alias:@main/store/repositories.js=./scripts/maint-m20-smoke/stubs/repositories.ts \
  --alias:@main/lib/logger.js=./scripts/maint-m20-smoke/stubs/logger.ts \
  --alias:react=./scripts/maint-m20-smoke/stubs/react.ts \
  --alias:@renderer/lib/api.js=./scripts/maint-m20-smoke/stubs/api.ts \
  --outfile="$OUT/m20.mjs" --log-level=error
node "$OUT/m20.mjs"
node scripts/maint-m20-smoke/ui-regressions.mjs
