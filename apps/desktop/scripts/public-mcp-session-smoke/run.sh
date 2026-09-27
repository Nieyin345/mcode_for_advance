#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p ./.tmp
OUT=$(mktemp -d ./.tmp/mcode-public-mcp-session-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi
"$ESBUILD" scripts/public-mcp-session-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:@main/utils.js=./scripts/public-mcp-session-smoke/stubs/utils.ts \
  --alias:@main/lib/logger.js=./scripts/public-mcp-session-smoke/stubs/logger.ts \
  --alias:@main/store/repositories.js=./scripts/public-mcp-session-smoke/stubs/repositories.ts \
  --alias:@main/providers/bridge/publicMcpServer.js=./scripts/public-mcp-session-smoke/stubs/publicMcpServer.ts \
  --alias:@main/providers/bridge/tunnelManager.js=./scripts/public-mcp-session-smoke/stubs/tunnelManager.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
