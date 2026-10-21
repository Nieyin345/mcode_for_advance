#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-mc035-egress.XXXXXX")
trap 'rm -rf "$OUT"' EXIT
source "scripts/lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "esbuild missing" >&2; exit 2; fi
mcode_esbuild scripts/mc035-egress-isolation-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
