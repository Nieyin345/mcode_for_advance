#!/usr/bin/env bash
# Perf backlog #5: the renderer build no longer ships .gz/.br copies; the
# mobile HTTP server compresses static assets on demand (bounded LRU).
#
# Bundles the real src/main/mobile/serveMobileStatic.ts (electron + logger
# stubbed, read-only reuse of mobile-pairing-smoke / db-migrate-smoke stubs),
# serves a mktemp web root on 127.0.0.1:<random port>, and checks encodings,
# byte-identity after decoding, caching and the legacy sibling path. Nothing
# touches userData, the LAN or the real out/renderer.
set -euo pipefail
cd "$(dirname "$0")/../.."

mkdir -p ./.tmp
OUT=$(mktemp -d ./.tmp/mcode-mobile-static-compress-smoke.XXXXXX)
BOX=$(mktemp -d "${TMPDIR:-/tmp}/mcode-mobile-static-box.XXXXXX")
trap 'rm -rf "$OUT" "$BOX"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then echo "esbuild not found in node_modules (no network fallback)" >&2; exit 1; fi

BANNER="import { createRequire as __cr } from 'node:module'; \
import { fileURLToPath as __f2p } from 'node:url'; \
import { dirname as __dn } from 'node:path'; \
const require = __cr(import.meta.url); \
const __dirname = __dn(__f2p(import.meta.url));"

"$ESBUILD" scripts/mobile-static-compress-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="$BANNER" \
  --alias:electron=./scripts/mobile-pairing-smoke/stubs/electron.ts \
  --alias:@main/lib/logger.js=./scripts/db-migrate-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MOBILE_STATIC_BOX="$BOX" node "$OUT/smoke.mjs"
