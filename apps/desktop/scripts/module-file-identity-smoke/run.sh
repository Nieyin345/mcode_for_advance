#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-file-identity.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source scripts/lib/esbuild-path.sh
if [[ -z "${ESBUILD:-}" ]]; then echo "esbuild unavailable" >&2; exit 1; fi
"$ESBUILD" scripts/module-file-identity-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:node:fs/promises=./scripts/module-file-identity-smoke/fsPromisesStub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
