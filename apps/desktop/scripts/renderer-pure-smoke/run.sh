#!/usr/bin/env bash
# 渲染端**纯逻辑**三件的回归网 —— 这三个文件此前一套覆盖都没有:
#   - `ide/commitGraph.ts`   git 历史图的泳道排布
#   - `lib/lineDiff.ts`      行级 LCS diff
#   - `ide/turnFlowModel.ts` Turn Flow 面板的派生(分组/用量匹配/工具分类/计数)
#
# 三个都**不碰 DOM / store**(只 import type),所以 esbuild 打包后直接 node 跑,
# 但**仍需一个 alias**：`sessionStore.ts` 里有一处 `await import("@renderer/lib/monacoSetup.js")`
# （编辑器配色方案那次的动态加载），esbuild 会把动态 import 一并打包，
# 而 `monacoSetup.ts` 里有 `monaco-editor/esm/...?worker` —— `?worker` 后缀
# 只有 vite 认，esbuild 会报 "Could not resolve"。
# 这套验的是纯派生，不需要 Monaco，所以换成空壳（仓库既有做法）。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d /tmp/mcode-renderer-pure-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"

"$ESBUILD" scripts/renderer-pure-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --alias:@renderer/lib/monacoSetup.js=./scripts/chat-linecount-smoke/monaco-stub.ts \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
