#!/usr/bin/env bash
# MAINT-2026-09 / M15: mobile HTTP server — static-root containment and the
# body cap on the unauthenticated pairing endpoint.
#
# Reuses mobile-pairing-smoke's stubs (read-only) and its bundling recipe:
# the real createMobileRequestHandler is bound to 127.0.0.1 + a random port,
# the sqlite store lives in a mktemp data root, and the web root / its sibling
# "secret" dir live in their own mktemp box. Nothing touches the LAN or userData.
set -euo pipefail
cd "$(dirname "$0")/../.."

# Built under apps/desktop/.tmp so the externalised ssh2 resolves at runtime
# (same reason as mobile-pairing-smoke).
mkdir -p ./.tmp
OUT=$(mktemp -d ./.tmp/mcode-maint-m15-smoke.XXXXXX)
DATA=$(mktemp -d "${TMPDIR:-/tmp}/mcode-maint-m15-data.XXXXXX")
BOX=$(mktemp -d "${TMPDIR:-/tmp}/mcode-maint-m15-box.XXXXXX")
trap 'rm -rf "$OUT" "$DATA" "$BOX"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "esbuild not found in node_modules (no network fallback)" >&2; exit 1; fi

BANNER="import { createRequire as __cr } from 'node:module'; \
import { fileURLToPath as __f2p } from 'node:url'; \
import { dirname as __dn } from 'node:path'; \
const require = __cr(import.meta.url); \
const __dirname = __dn(__f2p(import.meta.url));"

P=./scripts/mobile-pairing-smoke/stubs
"$ESBUILD" scripts/maint-m15-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --external:ssh2 \
  --banner:js="$BANNER" \
  --alias:electron=$P/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/db-migrate-smoke/stubs/logger.ts \
  --alias:@main/window.js=$P/window.ts \
  --alias:@main/browser/BrowserManager.js=$P/browserManager.ts \
  --alias:@main/workflows/seed.js=$P/workflowsSeed.ts \
  --alias:@main/claude/RuntimeManager.js=$P/runtimeManager.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" MAINT_M15_BOX="$BOX" node "$OUT/smoke.mjs"
