#!/usr/bin/env bash
# O3 —— 安装版（解压态）六格式 U1。
#
# 前提：`apps/desktop/release/win-unpacked/` 已存在（875M，`resources/genoffice` 167M）。
# **本套件不打包**（卡第四节：用户明确说过没做好之前不要打包）。产物缺失时直接失败。
#
# 用法：
#   bash apps/desktop/scripts/o3-packaged-u1/run.sh             # 正常跑（期望 exit 0）
#   bash apps/desktop/scripts/o3-packaged-u1/run.sh --mutate    # 变异验证（见 mutators.mjs）
#
# 套件名必须匹配 scripts/run-smokes.mjs 的 `-smoke` 发现规则，入口在
# `scripts/o3-packaged-smoke/run.sh`（只转调本文件）。本文件同时可被直接执行。
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ "${1:-}" = "--mutate" ]; then
  exec node scripts/o3-packaged-u1/mutators.mjs
fi

exec node scripts/o3-packaged-u1/main.mjs
