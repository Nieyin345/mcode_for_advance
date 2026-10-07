#!/usr/bin/env bash
# Headless smoke for the mcode-workflow MCP tools (AI 自己改工作流那一套).
#
# Two halves:
#   1. 归一化 + 存盘那两道关(纯逻辑,见 main.ts 上半)。
#   2. **真的** MCP server —— 建出来、把它注册的工具挖出来、直接调它们的 handler,
#      于是"工具叫什么、收什么参数、返回什么"验在真东西上。
#
# What is NOT covered: the model's side of it (does it read the description right),
# and the canUseTool approval chain. Those need a live conversation.
#
# The store layer really runs, so it needs a data root: it gets a temp one. The
# modules that import electron are replaced (see stubs/).
set -euo pipefail
cd "$(dirname "$0")/../.."

# ⚠️ 产物必须落在**仓库里**(`.tmp/` 下),不能在 mktemp 的目录里:后半段要 `import
# ("@anthropic-ai/claude-agent-sdk")`,而裸包名是按**产物文件的位置**往上找 node_modules
# 的。放到 /tmp 里那句 import 会解析失败 —— 而它恰好是这个 suite 最值钱的那一半。
OUT=$(mktemp -d ./.tmp/mcode-admin-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-admin-smoke-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
source "$(dirname "$0")/../lib/esbuild-path.sh"

# SDK 保持惰性 `import`(不打进 bundle):它很大,而且里面那套东西本来就不是给无头脚本
# 准备的。留着 external,node 从 .tmp/ 往上就能找到 apps/desktop/node_modules 里那一份。
"$ESBUILD" scripts/mcode-admin-smoke/main.ts \
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
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
