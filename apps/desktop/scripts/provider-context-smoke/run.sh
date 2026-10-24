#!/usr/bin/env bash
# 三引擎共享上下文（工作流 / 角色 / 主对话记忆）回归。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d /tmp/mcode-provider-context-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"

# 【T64】AST 判据需要 typescript 编译器 API。它内部用 CJS 的 `require("fs")`，
# 打进 ESM bundle 会变成不支持的动态 require —— 用 --external 让它走运行时 import。
"$ESBUILD" scripts/provider-context-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --external:typescript \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
