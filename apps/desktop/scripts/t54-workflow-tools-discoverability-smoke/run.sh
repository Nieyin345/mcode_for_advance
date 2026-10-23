#!/usr/bin/env bash
# 【T54】可发现性：mcode-workflow 那套工具不该是「搜不到就不存在」。
#
# 本套**只读**：不写仓库文件、不动数据根、不起 Electron。
# `workflowMcpTools()` 与 `WORKFLOW_TOOL_SURFACE` 都是纯声明表，读它们不需要 DB。
set -euo pipefail
cd "$(dirname "$0")/../.."        # → apps/desktop
source scripts/lib/esbuild-path.sh

# ⚠️ 产物必须落在**仓库里**(`.tmp/` 下),不能在 mktemp 的 tmpdir 里:
# `--external:ssh2` / `--external:@anthropic-ai/claude-agent-sdk` 是按**产物文件的位置**
# 往上找 node_modules 的。放到 /tmp 里那句 import 会解析失败（与 mcode-admin-smoke 同一条）。
OUT=$(mktemp -d ./.tmp/t54-discoverability.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-t54-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

# 与 mcode-admin-smoke 同一条换桩理由：`mcodeServer` 会牵进 electron 与插件管理器。
"$ESBUILD" scripts/t54-workflow-tools-discoverability-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --external:ssh2 \
  --external:@anthropic-ai/claude-agent-sdk \
  --alias:@main/lib/dataRoot.js=./scripts/mcode-admin-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/mcode-admin-smoke/stubs/logger.ts \
  --alias:@main/store/repositories.js=./scripts/mcode-admin-smoke/stubs/repositories.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/mcode-admin-smoke/stubs/pluginManager.ts \
  --alias:@main/orchestration/broadcast.js=./scripts/mcode-admin-smoke/stubs/broadcast.ts \
  --alias:@main/library/broadcast.js=./scripts/mcode-admin-smoke/stubs/libraryBroadcast.ts \
  --alias:@main/mcp/libraryServer.js=./scripts/mcp-endpoint-smoke/stubs/libraryServer.ts \
  --alias:@main/window.js=./scripts/library-mcp-smoke/stubs/window.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
