#!/usr/bin/env bash
# Headless smoke for MCP 服务器 per-engine 可见性(main/lib/mcpEngines.ts).
#
# mcpEngines 是纯核心(不 import electron;MCODE_CONFIG_DIR 只是 homedir 拼接),
# 所以可以直接 bundle:覆盖矩阵语义(missing=enabled / 最小化 / pi 钉死 / 坏文件
# 防御)、派生视图(enabled ∧ assigned ∧ 不在 stash)与 toggle 行为表(含纯度)。
# 没有覆盖的:db 绑定的 IPC handler 与两个引擎的物化消费点,靠真机验收。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-mcp-engines-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/mcp-engines-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
