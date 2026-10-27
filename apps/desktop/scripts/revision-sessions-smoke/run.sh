#!/usr/bin/env bash
# Headless smoke for 【Office 深度集成】修订会话与待审改动（`main/document/revisionSessions.ts`
# + `pendingChanges.ts`）。见 main.ts 文件头。
#
# ## 为什么不用起 Electron
#
# 这两块是**纯数据层**：一个按路径管理"这个文档有哪些待审改动/评论"，一个定义那些
# 条目的统一形状。它们不碰 Electron、不碰 sql.js、不碰磁盘 —— 连着包一起 esbuild
# 出来直接跑。
#
# ## 数据根
#
# 本套件不读写磁盘，但照例挂 dataRoot 桩：任何意外触碰都会**直接抛**，
# 不会回落到用户的真数据根。
#
# ## 这个脚本从仓库根调用也能跑
#
# `cd "$SCRIPT_DIR/../.."` 之后**只能**用 `$SCRIPT_DIR`，不能再 `dirname "$0"`
# （那时 `$0` 还是调用者给的相对路径）。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."

OUT=$(mktemp -d /tmp/mcode-revision-sessions-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-revision-sessions-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$SCRIPT_DIR/../lib/esbuild-path.sh"

"$ESBUILD" scripts/revision-sessions-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
