#!/usr/bin/env bash
# t139-message-alignment-smoke — 聊天消息对齐 Claude 的四个改动（见 main.ts 文件头）。
#
# ⚠️ HERE 必须先算绝对路径再 cd —— 本仓库有套件因为依赖调用者 cwd 而在
# 从仓库根调用时静默失败（rc=127，「取通过数」得到空串，看起来像 0 红）。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d /tmp/mcode-t139-align.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

source "$HERE/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "esbuild not found in node_modules (no network fallback)" >&2; exit 1; fi

"$ESBUILD" "$HERE/main.ts" \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
