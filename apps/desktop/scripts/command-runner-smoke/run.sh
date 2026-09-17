#!/usr/bin/env bash
# Headless smoke for 命令节点执行器(commandRunner)。
#
# 调度器那一半的写法(scheduler-smoke):esbuild 打包 + 纯 node 跑。真 spawn 的那几组
# 用例会起真的 node 子进程(包括一个被超时杀掉的死循环和一个被中止的长进程),但不碰
# 数据库、不碰数据根 —— commandRunner 本身只依赖 node 内置模块和 @contracts/nodeType。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-command-runner-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# ESM, not CJS: the smoke uses top-level await, which the cjs output format rejects.
"$ESBUILD" scripts/command-runner-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
