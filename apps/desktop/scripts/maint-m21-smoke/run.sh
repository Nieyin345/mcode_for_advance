#!/usr/bin/env bash
# MAINT-2026-09 / M21 的独占套件(只由 M21 这个对话维护)。
# 验 OnlyOffice 本机安装链路:检测的读取、以及**提权那一步到底喂给 Windows 什么**。
# 绝不真的下载安装包、不真的提权、不起任何子进程(node:child_process 已被替身顶替),
# ProgramFiles / TEMP 全部指向 mktemp 出来的假目录。
set -euo pipefail
node "$(dirname "$0")/run.cjs"
