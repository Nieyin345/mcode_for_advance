#!/usr/bin/env bash
# 【MC-002】真 Electron 下的「崩溃后发现未完成部署 → 恢复 → 重新批准 → 续跑」UI U1。
# 见 build.mjs / probe.ts 文件头。
#
# 本套件**必须**用真 Electron 二进制:假 DOM / 纯函数验不了「用户在空输入框上能不能
# 看见盘上的记录」「点恢复后原快照真的回到 textarea」「点续跑后只派发剩余步」这三件
# 事 —— 而台账 remaining 恰恰是这三件。Electron 已在 devDependencies 里;没有就显式
# 失败,不联网下载。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/scene-deploy-electron-smoke/build.mjs
