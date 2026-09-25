#!/usr/bin/env bash
# Headless smoke for **`main/workflows/assets.ts` 的 `LIBRARY_PY`** —— 那个交给模型的
# 只读查询脚本(`python library.py list/find/show/files/notes/collections`)。
#
# ## 为什么单独一套
#
# 这个脚本**不在 TypeScript 的类型系统里** —— 它是一段反引号里的 Python 字面量。
# tsc 看不见它里面写没写错,而它又**直读 sqlite**:列名写错、SQL 语法坏、`--kind` 那种
# 参数退役之后还在查 `kind` 列,全都要到"用户真去用了"才暴露,而且暴露出来的样子是
# "模型说库里什么都没有" —— 一句不会指向本仓库任何一行代码的话。
#
# kind 退役(2026-09-24)那一轮正是这个形状:`--kind paper` 去查一个**已经停写**的列,
# 于是永远返回空;而全仓 92 套 smoke 一套都没红,因为没有一套碰过这个脚本。
#
# ## 它验的是**真跑**,不是文本
#
# 把字面量落成真的 `.py` 文件,用真的 python 解释器跑,喂一个真的 sqlite 临时库。
# 断言"输出里有那条条目 / 没有那条条目"而不是"源码里写着某个字符串" —— 后者在一个
# 语法坏掉的脚本上照样绿(见仓规「断言要测行为不是文本」)。
#
# Run: scripts/library-py-smoke/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-libpy-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# 1. 把 LIBRARY_PY 那个字面量落成文件。
#    ⚠️ 走 esbuild 打包再 import,而不是正则抠源码 —— 抠源码的话,TMPl literal 里
#    将来出现转义(`\${`、`\`)时抠出来的东西与真实运行的那份不一样,而那正是这套
#    要防的。打包是**真值**。
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/library-py-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs" "$OUT"
