#!/usr/bin/env bash
# Headless smoke for **`main/workflows/assets.ts` 的 `MINERU_PY`** —— 内置自动化
# 「下载完自动转 Markdown」那一步跑的转录脚本。
#
# ## 为什么单独一套
#
# 这个脚本**不在 TypeScript 的类型系统里** —— 它是一段反引号里的 Python 字面量。
# tsc 看不见它里面写没写错，而它要办的事全是**协议交互**（申请上传链接 → PUT 上传 →
# 轮询 → 取 zip → 解出 full.md + 配图）。错一处不报错，只是**转不出东西**。
#
# 同 `library-py-smoke` 的取舍：那套是给 `LIBRARY_PY` 的，这是给它旁边那个新脚本的。
#
# ## 不联网
#
# 本套起一个**本地假 MinerU 服务端**（127.0.0.1 随机端口），秒级、不烧额度，而且能
# **故意造失败**（token 错、解析失败、越界 zip）—— 真 API 那几种造不出来。
#
# ## 它验的是**真跑**，不是文本
#
# 把 `MINERU_PY` 那个字面量落成真的 `.py`，用真的 python 跑，断言 stdout 上那行
# `@@mcode:result` 里**真有什么** —— 而不是"源码里写着某个字符串"（后者在一个语法
# 坏掉的脚本上照样绿）。
#
# Run: scripts/mineru-py-smoke/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-mineru-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# 走 esbuild 打包再 import，而不是正则抠源码 —— 抠源码的话，模板字符串里出现转义时
# 抠出来的东西与真实运行的那份不一样，而那正是这套要防的。打包是**真值**。
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/mineru-py-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs" "$OUT"
