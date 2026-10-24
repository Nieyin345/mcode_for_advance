#!/usr/bin/env bash
# 【T122】聊天节律 + 版心 gutter 回归。
#
# 这套**不 import 任何主进程代码** —— 它只读 `src/renderer/styles.css`，
# 剥注释后解析声明，按 CSS 语义算最终像素，断言「关系」而不是「值」。
#
# 用 esbuild 打一次薄包（main.ts 是 TS），然后 node 跑。
set -euo pipefail
# ⚠️ cwd 一改，`dirname "$0"` 的相对路径就失效了（本仓 t121 就是这么坏的：
# 用相对路径调用时，cd 之后的 source 指向了不存在的路径）。先在原地算绝对路径。
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
source "$HERE/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "Missing existing esbuild; no dependency installation attempted" >&2; exit 1; fi

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-t122-rhythm.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

"$ESBUILD" scripts/t122-chat-rhythm-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
