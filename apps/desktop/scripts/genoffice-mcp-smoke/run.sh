#!/usr/bin/env bash
# Headless smoke for GenOffice 无头 MCP server 作为可选 MCP 条目（见 main.ts 文件头）。
#
# 被测：src/main/mcp/genofficeMcp.ts（条目形状 + 围栏环境）、真 `genoffice mcp`
# stdio server（真子进程 + JSON-RPC）、Mcode 现有 MCP 登记面（契约 schema /
# 真相层派生视图 / 引擎矩阵），以及**安装入口 handler（mcp.genofficeInstall）**
# 在真 sql.js 库上的行为（§2b：CLI 缺失拒绝且不写库 / 有根时写出带围栏的条目 /
# 空根拒绝 / 重复名与 replace）。
#
# ⚠️ §2b 起本套会 import `ipc/mcp.ts`，它的 import 图深处会拉 electron；而
# `registerMcpHandlers` 末尾还会火忘式执行真相层迁移 + 物化两个引擎视图 ——
# 两者都会往 `~/.mcode/.claude.json` 与 `~/.mcode/codex/config.toml` 写字。
# 所以下面除了数据根桩之外**还必须**把 HOME 换到临时目录，否则就是拿空配置覆盖
# 用户真实的 ~/.mcode（与 mcp-ipc-smoke 的 run.sh 同一条安全前提）。
set -euo pipefail
cd "$(dirname "$0")/../.."
DESKTOP="$PWD"

OUT=$(mktemp -d /tmp/mcode-genoffice-mcp-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-genoffice-mcp-smoke-data.XXXXXX)
FAKE_HOME=$(mktemp -d /tmp/mcode-genoffice-mcp-smoke-home.XXXXXX)
HOME="$FAKE_HOME" USERPROFILE="$FAKE_HOME" mkdir -p "$FAKE_HOME/.mcode"
trap 'rm -rf "$OUT" "$DATA" "$FAKE_HOME"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/genoffice-mcp-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/mcp-ipc-smoke/stubs/electron.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/mcp-ipc-smoke/stubs/pluginManager.ts \
  --alias:@main/terminal/TerminalManager.js=./scripts/mcp-ipc-smoke/stubs/terminalManager.ts \
  --alias:node-pty=./scripts/mcp-ipc-smoke/stubs/nodePty.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

# 给 bundle 一个 node_modules 视野:sql.js 的 wasm 在运行期从 bundle 自己位置解析。
ln -s "$DESKTOP/node_modules" "$OUT/node_modules"

HOME="$FAKE_HOME" USERPROFILE="$FAKE_HOME" \
  MCODE_SMOKE_DATA_ROOT="$DATA" \
  node "$OUT/smoke.mjs"
