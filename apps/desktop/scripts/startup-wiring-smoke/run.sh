#!/usr/bin/env bash
# Headless smoke for the app startup assembly sequence.
#
# `main/index.ts`（应用装配根）顶层就 import electron 且跑真实装配，无头引不动 —— 于是
# `smokes-for.sh --uncovered` 把它列为零覆盖。本套测的是从那一段里抽出来的 electron-free
# 纯函数 `main/startup/assembleStartup.ts`：真 bundle、真跑、断言**可观察的装配结果**
# （落盘 store 真的落盘 / 单例真的被换 / 注入点真的被调到且顺序对 / 某步抛了会中止并如实抛）。
#
# ⚠️ 两个前提：
#   - `MCODE_SMOKE_DATA_ROOT` 指到 mktemp —— 落盘 store 会往数据根写 JSON；指到真数据根
#     会污染用户目录。本套不 open 数据库，但落盘文件同样必须隔离。
#   - `wiring-guard.mjs` 用 TS AST 断言 `index.ts` **真的还在调 `assembleStartup()`**、
#     且原来那几条内联装配**不再留在 index.ts** —— 这是「抽出去了却没人接线」那类洞的回归网
#     （抽出来的纯函数没被 index.ts 接上 = 装配整个消失，而单测照样绿）。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-startup-wiring-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-startup-wiring-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then
  echo 'esbuild is missing; install workspace dependencies before running smoke tests' >&2
  exit 1
fi

"$ESBUILD" scripts/startup-wiring-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"
node "$OUT/smoke.mjs"

# index.ts 的接线回归网（读源码 AST，不起 Electron）。
node scripts/startup-wiring-smoke/wiring-guard.mjs
