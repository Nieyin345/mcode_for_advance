#!/usr/bin/env bash
# Reliable SSH / detached remote-job smoke.
set -euo pipefail
cd "$(dirname "$0")/../.."

mkdir -p ./.tmp/remote-ssh-smoke
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/remote-ssh-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --packages=external --tsconfig=tsconfig.json \
  --external:ssh2 \
  --alias:@main/store/repositories.js=./scripts/remote-ssh-smoke/stubs/settingRepo.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/mcp/libraryServer.js=./scripts/mcp-endpoint-smoke/stubs/libraryServer.ts \
  --alias:@main/lib/dataRoot.js=./scripts/mcode-admin-smoke/stubs/dataRoot.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/mcode-admin-smoke/stubs/pluginManager.ts \
  --alias:@main/orchestration/broadcast.js=./scripts/mcode-admin-smoke/stubs/broadcast.ts \
  --alias:@main/memory/broadcast.js=./scripts/mcp-endpoint-smoke/stubs/memoryBroadcast.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --alias:electron=./scripts/mobile-pairing-smoke/stubs/electron.ts \
  --outfile=./.tmp/remote-ssh-smoke/smoke.mjs --log-level=error

node ./.tmp/remote-ssh-smoke/smoke.mjs
