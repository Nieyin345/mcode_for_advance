#!/usr/bin/env bash
# 【MC-046 U1】真 Electron 下的设置覆盖层焦点所有权（台账 remaining 的 U1）。
# 见 build.mjs / probe.ts 文件头。Electron 已在 devDependencies；没有就显式失败，不联网下载。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/settings-focus-electron-smoke/build.mjs
