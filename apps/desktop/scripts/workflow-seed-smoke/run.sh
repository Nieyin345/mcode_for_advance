#!/usr/bin/env bash
# Headless smoke for **`main/workflows/seed.ts`** —— 流程脚本落盘到 `<数据根>/workflows/`。
#
# ## 为什么有这一套
#
# 从前 seed 只在「文件不存在」时写,于是老安装**永远停在第一次装的那一版**:2026-09-26
# 查出来用户磁盘上的 library.py 还是 9 月 16 日那份 —— 没有屏蔽逻辑、还收已经退役的
# `--kind`。系统提示词叫 AI 用它查库,屏蔽了的条目在 AI 眼里一条不少。
#
# 现在的规则:**没改过的旧版自动换成新版,改过的一律不动**。这一套验的就是这两半:
# 用 git 取出**真发过的**旧版 library.py(不是手写的假旧版),看它会不会被认成原版并升级;
# 再在上面改一行,看它会不会被留着。
#
# Run: scripts/workflow-seed-smoke/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-seed-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# 真发过的旧版:e1687e4 那一版 assets.ts(用户磁盘上那份 library.py 就出自它)。
# 走 esbuild 打包取字面量的真值,而不是正则抠 —— 与 library-py-smoke 同理。
mkdir -p "$OUT/legacy"
git show e1687e4:apps/desktop/src/main/workflows/assets.ts > "$OUT/legacy/assets.ts"
"$ESBUILD" "$OUT/legacy/assets.ts" --bundle --platform=node --format=esm \
  --outfile="$OUT/legacy.mjs" --log-level=error

STUBS=scripts/run-store-smoke/stubs
"$ESBUILD" scripts/workflow-seed-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/dataRoot.js=./$STUBS/dataRoot.ts \
  --alias:@main/lib/logger.js=./$STUBS/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

mkdir -p "$OUT/data"
MCODE_SMOKE_DATA_ROOT="$OUT/data" node "$OUT/smoke.mjs" "$OUT/legacy.mjs"
