#!/usr/bin/env bash
# O2 —— 六格式保存冲突取证套件（真 Electron + CDP，复用 electron-u1 执行器）。
#
# 退出码：
#   0 = 结论与 expectations.ts 一致（docs/sheets 拦住；slides/pdf/markdown/html
#       按预期被静默覆盖）。**注意 0 不等于「六格全绿」** —— 这一套是取证套件，
#       四个格式的「预期红」本身就是结论（卡 §四）。
#   1 = 与期望不一致（缺口被修好了 / 红的理由变了 / 构建失败）。
#
# 修好那四个格式之后：把 expectations.ts 的 expectConflict 翻成 true，
# 本套件就变成「六格必须全绿」的回归网（run.mjs --variant=expect-green）。
set -euo pipefail
node "$(dirname "$0")/run.mjs" "$@"
