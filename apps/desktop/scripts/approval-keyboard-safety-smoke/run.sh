#!/usr/bin/env bash
# T6 — 审批卡键盘/焦点/拒绝路径的隔离组件回归（真 Chromium + 真生产组件）。
#
# 判据落在真实 DOM / 真实按键 / 真实焦点上：见 verify.mjs 文件头。
# 需要本机已装 Edge/Chrome（browser.mjs 只用自己的 profile/端口，从不 attached 到既有浏览器）。
# 这是 E1 隔离组件证据，不是真实 Electron U1 —— 主进程审批桥与真 IPC 另验。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/approval-keyboard-safety-smoke/build.mjs
