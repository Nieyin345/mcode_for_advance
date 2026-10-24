#!/usr/bin/env bash
# 【T147】对话正文行高必须等于上游 `leading-relaxed`（1.625）。
#
# 这套读两个东西的**真身**：
#   1. `src/renderer/styles.css` 里三档 `--chat-md-leading` 的实际值
#   2. `components/chat/Markdown.tsx` 里 `[line-height:var(--chat-md-leading)]`
#      这个真实使用点（否则改定义等于改一个死变量）
#
# 为什么不用 `src.includes("1.625")`：那在注释里出现也算命中。所有断言都先
# 剥掉注释（`/* */` 与 `//`），再按 `--chat-md-leading` 后面的值精确匹配。
#
# 变异验证记录（写回时更新）：
#   默认档改回 1.45        → 应红 1（[1] 的默认档断言）
#   三档改成相同值          → 应红 1（[2] 单调性）
#   删掉定义但保留使用点    → 应红 1（[1] 三档齐备）
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
source "$HERE/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "Missing existing esbuild; no dependency installation attempted" >&2; exit 1; fi

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-t147-leading.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

"$ESBUILD" scripts/t147-chat-leading-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
