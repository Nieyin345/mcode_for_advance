#!/usr/bin/env bash
# Headless smoke for the base-capability matrix (ARC-003).
#
# 纯模块 + 主进程真实工具表。`ipc/engineTools.ts` / `agentEngineBridge.ts` 走
# electron 的 logger / BrowserManager 依赖,用 effective-tools-smoke 同款桩，不起 Electron、
# 不碰 ~/.mcode、不写盘。
set -euo pipefail
cd "$(dirname "$0")/../.."          # → apps/desktop

# 产物必须落在 `apps/desktop/.tmp/`(不是 /tmp):`--external:ssh2` 的裸包名由 node
# 从产物目录往上找 node_modules;Windows 的 /tmp 落在 %LOCALAPPDATA%\Temp,往上找不到仓库。
OUT=$(mktemp -d ./.tmp/base-capability-matrix.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "${ESBUILD:-}" ]]; then echo "esbuild not found in node_modules (no network fallback)" >&2; exit 1; fi
mkdir -p ./.tmp

"$ESBUILD" scripts/base-capability-matrix-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --external:ssh2 \
  --external:@anthropic-ai/claude-agent-sdk \
  --alias:electron=./scripts/agent-mail-smoke/stubs/electron.ts \
  --alias:@main/window.js=./scripts/agent-mail-smoke/stubs/window.ts \
  --alias:@main/lib/theme.js=./scripts/library-mcp-smoke/stubs/theme.ts \
  --alias:@main/lib/secretStore.js=./scripts/library-mcp-smoke/stubs/secretStore.ts \
  --alias:@main/lib/logger.js=./scripts/mcode-admin-smoke/stubs/logger.ts \
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/mcode-admin-smoke/stubs/pluginManager.ts \
  --alias:@main/orchestration/broadcast.js=./scripts/mcode-admin-smoke/stubs/broadcast.ts \
  --alias:@main/memory/broadcast.js=./scripts/mcp-endpoint-smoke/stubs/memoryBroadcast.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/app-control-smoke/stubs/runtimeManager.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
