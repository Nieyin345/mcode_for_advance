#!/usr/bin/env bash
# 【ARC-006 NR2】真 Electron 下的第三方工作流引擎编辑器宿主 U1
# （真窗口 + 真 WebContentsView + 真引擎子进程 + 真 HTTP 编辑器页）。
# 见 build.mjs / probe.ts 文件头。
#
# 本套件**必须**用真 Electron 二进制：无头套件里的假视图验不了「WebContentsView
# 真的加载了引擎的 HTTP 编辑器页」「hide 后页面状态真的还在」「close 后真的没有
# 孤儿 webContents」。Electron 已在 devDependencies 里；没有就显式失败，不联网下载。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/workflow-engine-electron-smoke/build.mjs
