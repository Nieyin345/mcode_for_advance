#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."
OUT=$(mktemp -d /tmp/mcode-t54-pane.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$SCRIPT_DIR/../lib/esbuild-path.sh"
"$ESBUILD" scripts/genoffice-pane-fence-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:electron=./scripts/genoffice-pane-fence-smoke/stubs/electron.ts \
  --outfile="$OUT/check.mjs" --log-level=error
node "$OUT/check.mjs"
node scripts/genoffice-pane-fence-smoke/mutation-check.mjs
