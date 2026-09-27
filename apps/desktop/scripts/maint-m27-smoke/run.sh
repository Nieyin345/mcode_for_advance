#!/usr/bin/env bash
# MAINT-2026-09 / M27 的独占套件(只由 M27 这个对话维护)。
# 验打包前置脚本「失败时必须真的失败」:把 build/ 下的真实脚本复制进 mkdtemp
# 假工程树里跑,看退出码与留下的现场。不跑 electron-builder、不打包、不联网,
# 也不碰仓库自己的 node_modules。
set -euo pipefail
node "$(dirname "$0")/run.cjs"
