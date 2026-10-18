#!/usr/bin/env bash
# 【ARC-007】真 Electron 下的文档视图宿主 U1（真窗口 + 真 WebContentsView + 真 preload）。
# 见 build.mjs / probe.ts 文件头。
#
# 本套件**必须**用真 Electron 二进制：假视图验不了「preload 真的注入」「menu:command
# 真的到达页面」这两件事 —— 上一轮的真断链（发到没人订阅的通道）正是只有真浏览器
# 才能抓到。Electron 已在 devDependencies 里；没有就显式失败，不联网下载。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/document-view-electron-smoke/build.mjs
