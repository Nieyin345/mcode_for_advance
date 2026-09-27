#!/usr/bin/env bash
# MAINT-2026-09 / M10 的独占套件(只由 M10 这个对话维护)。
# 真建一个临时 git 仓库、真跑 worktree add / remove,验的是 removeWorktree 的
# **删除边界**:哪些路径它有权递归删除、哪些必须拒绝。
# 不碰用户仓库(仓库与受管根都是 mktemp 出来的),不联网,不起 Electron。
set -euo pipefail
node "$(dirname "$0")/run.cjs"
