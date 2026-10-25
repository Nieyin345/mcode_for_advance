#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../.."
source "$HERE/../lib/esbuild-path.sh"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/mcode-docs-recovery.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/document-recovery-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error
"$ESBUILD" scripts/document-recovery-smoke/crashWorker.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/crash-worker.mjs" --log-level=error
MCODE_DOC_RECOVERY_CRASH_WORKER="$OUT/crash-worker.mjs" node "$OUT/smoke.mjs"
