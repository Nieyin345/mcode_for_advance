#!/usr/bin/env bash
# MAINT-2026-09 / M25: 通用设置与运行时面板(GeneralPanel / RuntimesPanel /
# DataRootPanel)。在自有的无头 Chromium(临时 profile、随机端口、退出即杀)里
# 渲染真实面板组件,对着页内 mock RPC 验三类判据:
#   1. IPC 拒绝时错误对用户可见,不落成未处理 promise 拒绝(错误可见性);
#   2. 长文本折叠阈值输入框在输入中途不被 clamp 抢改(草稿保持);
#   3. 内核行展开开关暴露 aria-expanded(可访问性)。
# 不触真实 IPC、不碰用户数据、不联网;浏览器缺失时明确失败,不安装、不跳过。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/maint-m25-smoke/build.mjs

