#!/usr/bin/env bash
# T0: GenOffice native tool same-turn round-trip through the isolated Host seam.
# fake RuntimeManager / repositories / Electron; real docsAiPorts + T98 Docs boundary.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."
OUT=$(mktemp -d /tmp/mcode-t0-native-tool.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$SCRIPT_DIR/../lib/esbuild-path.sh"
STUB=./scripts/t0-genoffice-native-tool-roundtrip-smoke/stubs/nativeAiMcode.ts
LOG=./scripts/t0-genoffice-native-tool-roundtrip-smoke/stubs/logger.ts
"$ESBUILD" scripts/t0-genoffice-native-tool-roundtrip-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/claude/RuntimeManager.js="$STUB" \
  --alias:@main/store/repositories.js="$STUB" \
  --alias:@main/providers/registry.js="$STUB" \
  --alias:@main/lib/pathGuard.js="$STUB" \
  --alias:@main/window.js="$STUB" \
  --alias:@main/lib/logger.js="$LOG" \
  --alias:electron="$STUB" \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
