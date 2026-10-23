#!/usr/bin/env bash
# 【T44】三套 GenOffice 溯源套件的并发隔离回归。
# 判据在真实 genoffice/ 工作树的状态上（并发后 / 被中断后都必须逐字未变）。
# 不需要 esbuild:这一套只 spawn 别的 run.sh 并读 git 状态。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/main.mjs"
