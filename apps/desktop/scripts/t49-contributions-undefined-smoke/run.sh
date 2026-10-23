#!/usr/bin/env bash
# T49 —— `contributionsOf(undefined, …)` 首帧崩溃的最小复现（纯 node，不起 Electron/浏览器）。
#
# 为什么不用浏览器：被测对象是**两个纯函数**，而要让它们崩溃只需要 `undefined`。
# 已有的 `module-contributions-smoke` 走真 UI 树，反而被 harness 的同步 mock 掩盖了
# 这个分支（harness 的 `catalog()` 立刻返回正常目录）。本套件直接钉那个分支。
#
# 源码来源：从**生产文件**里解析出两个纯函数（不是手抄，避免走样）；
# 见 main.ts 的 loadPureFunctions。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."

OUT=$(mktemp -d /tmp/mcode-t49-contributions.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$SCRIPT_DIR/../lib/esbuild-path.sh"

export ESBUILD

"$ESBUILD" scripts/t49-contributions-undefined-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
