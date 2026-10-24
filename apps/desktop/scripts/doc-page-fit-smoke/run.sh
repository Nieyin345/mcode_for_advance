#!/usr/bin/env bash
# 【T109】文档页面适配：表格有没有超出可打印区。
#
# 不需要 Electron、不需要数据库 —— 这一套只读两个真生成的 .docx 的字节。
# 用 genoffice CLI（真实生成 + 真实渲染），所以跑之前要确认它在那儿；
# 不在时套件自己会打印 SKIP 并以 0 退出（不伪装成通过）。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."

OUT=$(mktemp -d ./.tmp/mcode-doc-page-fit.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$SCRIPT_DIR/../lib/esbuild-path.sh"

"$ESBUILD" scripts/doc-page-fit-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
