#!/usr/bin/env bash
# 【T138】任务中心的字号/圆角判据。
#
# 只读两个组件的源码 + 剥注释后断言，不起 Electron。
#
# ⚠️ 用 HERE 先算绝对路径再 cd —— 否则从仓库根用相对路径调用时
# `$(dirname "$0")` 在 cd 之后就失效了（t121 / task-roster 都踩过）。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

source "$HERE/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "Missing existing esbuild; no dependency installation attempted" >&2; exit 1; fi

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-t138.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

"$ESBUILD" "$HERE/main.ts" \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
