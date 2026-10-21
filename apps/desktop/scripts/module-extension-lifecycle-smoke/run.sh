#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."          # → apps/desktop

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-ext-lifecycle.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

source "scripts/lib/esbuild-path.sh"

mcode_esbuild scripts/module-extension-lifecycle-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
