#!/usr/bin/env bash
# 【T121】设置页三处 token 的判据（T136）。
#
# 这套**不 import 任何主进程代码** —— 它只读 styles.css + tailwind.config.js +
# 组件源码，把各种字号写法解析成 px 再比较。
#
# ⚠️ 用 HERE 先算绝对路径再 cd —— 否则从仓库根用相对路径调用时
# `$(dirname "$0")` 在 cd 之后就失效了（t121 踩过这个）。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

source "$HERE/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "Missing existing esbuild; no dependency installation attempted" >&2; exit 1; fi

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-settings-tokens.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

"$ESBUILD" "$HERE/main.ts" \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
