#!/usr/bin/env bash
# 渲染库审计回归 —— renderer/lib 的命令/快捷键/路径/模型缓存纯逻辑。
# 只 import type + 纯函数，esbuild 打包后直接 node 跑。
# 但要一个 alias：`sessionStore.ts` 里 `await import("@renderer/lib/monacoSetup.js")`
# 的动态加载会被 esbuild 一并打包，而 `monacoSetup.ts` 用了 `?worker` 后缀
#（只有 vite 认），esbuild 直接报 "Could not resolve"。本套不验 Monaco，换空壳。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d /tmp/mcode-renderer-lib-audit-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"

"$ESBUILD" scripts/renderer-lib-audit-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --alias:@renderer/lib/monacoSetup.js=./scripts/chat-linecount-smoke/monaco-stub.ts \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
