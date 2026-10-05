#!/usr/bin/env bash
# Real temporary PDF/DOCX/PPTX/XLSX fixtures through agent_read_document.
# Requires existing Python with python-pptx/openpyxl; no dependency installation.
set -euo pipefail
cd "$(dirname "$0")/../.."

# Keep the bundle inside apps/desktop so runtime dynamic imports / require.resolve
# (notably pdfjs-dist + its cmaps) can walk up to this package's node_modules.
# A /tmp bundle makes production-valid package resolution fail only in the smoke.
mkdir -p ./.tmp
OUT=$(mktemp -d ./.tmp/mcode-document-read-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# fail clearly when absent rather than installing dependencies.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then echo "Missing existing esbuild; dependencies must be prepared separately" >&2; exit 1; fi

# 别名:
#   - logger —— 真那份拉 electron(理由同 extension-bridge-smoke);
#   - libraryServer —— 真那份要真的库 repos,无头给不出来(见 stubs/libraryServer.ts);
#   - dataRoot / repositories / pluginManager / broadcast —— 工作流那一半(真
#     mcodeServer 要的)走 mcode-admin-smoke 用过的同一组桩。两个套件共用同一份,
#     免得"桩的形状"各写一遍。
"$ESBUILD" scripts/document-read-smoke/main.ts \
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
