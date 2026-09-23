#!/usr/bin/env bash
# Headless smoke for the MCP endpoint (`main/providers/bridge/mcpEndpoint.ts`) and the
# web tool host (`main/mcp/webToolHost.ts`) that backs it.
#
# Two halves (see main.ts):
#   1. the protocol over **real HTTP** against the real extension bridge (real
#      listen on 127.0.0.1, real bearer token), with a **fake** tool host injected;
#   2. the real tool host — its dispatch, zod validation and approval gate — driven
#      directly, with the library table stubbed (see stubs/libraryServer.ts).
set -euo pipefail
cd "$(dirname "$0")/../.."

# Keep the bundle inside apps/desktop so runtime dynamic imports / require.resolve
# (notably pdfjs-dist + its cmaps) can walk up to this package's node_modules.
# A /tmp bundle makes production-valid package resolution fail only in the smoke.
mkdir -p ./.tmp
OUT=$(mktemp -d ./.tmp/mcode-mcp-endpoint-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# 别名:
#   - logger —— 真那份拉 electron(理由同 extension-bridge-smoke);
#   - libraryServer —— 真那份要真的库 repos,无头给不出来(见 stubs/libraryServer.ts);
#   - dataRoot / repositories / pluginManager / broadcast —— 工作流那一半(真
#     mcodeServer 要的)走 mcode-admin-smoke 用过的同一组桩。两个套件共用同一份,
#     免得"桩的形状"各写一遍。
"$ESBUILD" scripts/mcp-endpoint-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --external:ssh2 \
  --alias:@main/lib/logger.js=./scripts/mcp-endpoint-smoke/stub-logger.ts \
  --alias:@main/mcp/libraryServer.js=./scripts/mcp-endpoint-smoke/stubs/libraryServer.ts \
  --alias:@main/lib/dataRoot.js=./scripts/mcode-admin-smoke/stubs/dataRoot.ts \
  --alias:@main/store/repositories.js=./scripts/mcode-admin-smoke/stubs/repositories.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/mcode-admin-smoke/stubs/pluginManager.ts \
  --alias:@main/orchestration/broadcast.js=./scripts/mcode-admin-smoke/stubs/broadcast.ts \
  --alias:@main/memory/broadcast.js=./scripts/mcp-endpoint-smoke/stubs/memoryBroadcast.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

# esbuild folds pdfjs into smoke.mjs but its fake-worker loader still resolves
# ./pdf.worker.mjs relative to the bundle. Mirror the production asset beside
# the smoke bundle so this suite exercises real PDF extraction.
cp node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs "$OUT/pdf.worker.mjs"

node "$OUT/smoke.mjs"