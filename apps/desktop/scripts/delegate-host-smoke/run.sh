#!/usr/bin/env bash
# Headless regression net for `main/mcp/delegateHost.ts` — the permission boundary of the
# public-MCP agent delegation (the impure half that spins a real agent turn in a project).
#
# `smokes-for.sh src/main/mcp/delegateHost.ts` reported this file uncovered. The pure half
# (`delegateServer.ts`) is already covered by `mcp-endpoint-smoke`; this suite covers what
# that one cannot: the delegation session's `permissionMode`, its project mapping, the
# enable gate, and the denials.
#
# Bundling: delegateHost imports the real `publicMcpSession` (we assert its project-mapping
# behavior), which pulls `secretStore` / `publicMcpServer` / `tunnelManager` — all aliased to
# stubs (same set as `public-mcp-session-smoke/run.sh`). `RuntimeManager` is aliased to a
# recording stub so the whole provider graph (ssh2 native module) never enters the bundle.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p ./.tmp
OUT=$(mktemp -d ./.tmp/mcode-delegate-host-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/delegate-host-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:@main/utils.js=./scripts/delegate-host-smoke/stubs/utils.ts \
  --alias:@main/lib/logger.js=./scripts/delegate-host-smoke/stubs/logger.ts \
  --alias:@main/lib/secretStore.js=./scripts/custom-model-smoke/stubs/secretStore.ts \
  --alias:@main/store/repositories.js=./scripts/delegate-host-smoke/stubs/repositories.ts \
  --alias:@main/providers/bridge/publicMcpServer.js=./scripts/public-mcp-session-smoke/stubs/publicMcpServer.ts \
  --alias:@main/providers/bridge/tunnelManager.js=./scripts/public-mcp-session-smoke/stubs/tunnelManager.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/delegate-host-smoke/stubs/runtimeManager.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
