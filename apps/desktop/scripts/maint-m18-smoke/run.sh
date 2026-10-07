#!/usr/bin/env bash
# MAINT-2026-09 / M18: managed-runtime install slot containment.
# The real runtimeInstaller runs against a throwaway runtimes root inside a
# mktemp box; electron/window/logger are replaced by local stubs, and the
# electron stub throws on app.getPath so nothing can fall back to userData.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-maint-m18.XXXXXX")
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "esbuild not found in node_modules (no network fallback)" >&2; exit 1; fi

"$ESBUILD" scripts/maint-m18-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/maint-m18-smoke/stubs/electron.ts \
  --alias:@main/window.js=./scripts/maint-m18-smoke/stubs/window.ts \
  --alias:@main/lib/logger.js=./scripts/maint-m18-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

mkdir -p "$OUT/box"
MAINT_M18_BOX="$OUT/box" node "$OUT/smoke.mjs"
