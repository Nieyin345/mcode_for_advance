#!/usr/bin/env bash
# T91：adoptMarkdown 的两处 cpSync 在非 ASCII 路径上会不会崩（子进程取证）。
#
# 与 T90 同一个根因（nodejs/node#54476、#63970），但触发面更常见：
# T90 要「中文用户名」，本套只要「用户导入的 md 路径含中文」。
#
# 别名与数据根桩沿用 library-adopt-smoke（那条路要真的建库、真的往库根写文件）。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."

OUT=$(mktemp -d /tmp/mcode-t91.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-t91-data.XXXXXX)

# 权限注入是手动的（icacls 的拒绝 ACE 不向下继承），退出时逐个反转，否则临时目录删不掉。
cleanup() {
  for p in "$DATA/library/markdown/imported" "$DATA/library/markdown/imported"/*; do
    [[ -e "$p" ]] || continue
    icacls "$p" /remove:d "*S-1-1-0" >/dev/null 2>&1 || true
  done
  rm -rf "$OUT" "$DATA"
}
trap cleanup EXIT

# bundle 旁边要有 node_modules 视野（pdfText 那条动态 require.resolve 用）。
source scripts/lib/runtime-node-modules.sh
mcode_link_runtime_node_modules "$OUT" "$PWD/node_modules"

source scripts/lib/esbuild-path.sh

ALIASES=(
  --external:pdfjs-dist
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts
  --alias:@main/lib/logger.js=./scripts/db-migrate-smoke/stubs/logger.ts
  --alias:@main/window.js=./scripts/library-mcp-smoke/stubs/window.ts
  --alias:@main/claude/RuntimeManager.js=./scripts/library-import-smoke/stubs/runtimeManager.ts
  --alias:@main/browser/BrowserManager.js=./scripts/library-mcp-smoke/stubs/browserManager.ts
  --alias:@main/lib/theme.js=./scripts/library-mcp-smoke/stubs/theme.ts
  --alias:@main/lib/secretStore.js=./scripts/library-mcp-smoke/stubs/secretStore.ts
  --alias:@main/orchestration/codeRunner.js=./scripts/library-mcp-smoke/stubs/codeRunner.ts
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts
)

COMMON=(
  --bundle --platform=node --format=esm
  --tsconfig=tsconfig.json
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
  --log-level=error
)

"$ESBUILD" scripts/t91-adopt-markdown-cp-smoke/main.ts "${COMMON[@]}" "${ALIASES[@]}" --outfile="$OUT/main.mjs"
"$ESBUILD" scripts/t91-adopt-markdown-cp-smoke/probe.ts "${COMMON[@]}" "${ALIASES[@]}" --outfile="$OUT/probe.mjs"

export MCODE_SMOKE_DATA_ROOT="$DATA"
node "$OUT/main.mjs"
