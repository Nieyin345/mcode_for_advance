#!/usr/bin/env bash
# 【ARC-005】真 Electron 端到端：HTML 预览入口 → 浏览器面板 → 真 WebContentsView。
# 见 build.mjs / probe.ts 文件头。Electron 已在 devDependencies；没有就显式失败，不联网下载。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/html-preview-electron-smoke/build.mjs
