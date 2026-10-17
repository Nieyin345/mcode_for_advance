#!/usr/bin/env bash
# Headless smoke for GenOffice 无头 MCP server 作为可选 MCP 条目（见 main.ts 文件头）。
#
# 被测：src/main/mcp/genofficeMcp.ts（条目形状 + 围栏环境）、真 `genoffice mcp`
# stdio server（真子进程 + JSON-RPC），以及 Mcode 现有 MCP 登记面（契约 schema /
# 真相层派生视图 / 引擎矩阵）。
#
# 不需要数据根（不碰 db / sql.js）；但被 import 的模块链可能间接带 logger/dataRoot,
# 所以照例挂两个桩。CLI bundle 不存在时实机段显式 SKIP（配置面断言照跑）。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-genoffice-mcp-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-genoffice-mcp-smoke-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/genoffice-mcp-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
