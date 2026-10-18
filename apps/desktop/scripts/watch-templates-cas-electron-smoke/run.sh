#!/usr/bin/env bash
# 【MC-054】真 Electron 两端并发保存守望模板的 U1 验收（真窗口 + 真 preload + 真 sql.js 库）。
# 见 build.mjs / probe.ts 文件头。
#
# 本套件**必须**用真 Electron 二进制：无头套件里两端只是同一个进程里的两次函数调用，
# 证明不了「真渲染端组件 + 真 preload 桥 + 真 IPC + 真 sql.js 落盘」这一整条链；
# 台账 remaining 点名的正是「两个窗口真的同时点保存」与「Agent 经 app_api_call 与界面
# 同时保存」。Electron 已在 devDependencies 里；没有就显式失败，不联网下载。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/watch-templates-cas-electron-smoke/build.mjs
