#!/usr/bin/env bash
# 【MC-026 复核】真 Electron 下三个设置面板(模型配置 / 引擎工具 / 自动化)的
# 「读失败可见 / 重试真重发 / 保存失败保留输入」U1。见 build.mjs / probe.ts 文件头。
#
# 必须用真 Electron 二进制:无头套件用假 React 运行时验状态机,证明不了"错误条真的
# 画在页面上、点重试真的重发、保存失败后输入框仍是用户输入"这三件事。
# Electron 已在 devDependencies 里;没有就显式失败,不联网下载。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/settings-panels-electron-smoke/build.mjs
