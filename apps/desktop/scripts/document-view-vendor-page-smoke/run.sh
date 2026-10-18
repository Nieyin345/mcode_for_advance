#!/usr/bin/env bash
# 【ARC-007】真 Electron 加载**真实 GenOffice docs 编辑器页** —— 最小 preload 能挂起来吗。
# 见 build.mjs / probe.ts 文件头。
#
# 这套必须用真 Electron + 真实构建产物（`genoffice/apps/docs/out/renderer/index.html`）：
# 「React 19 无错误边界 → 一个缺失的 window.desktop 方法整树卸载」只有真浏览器能证明。
# 产物未构建时**如实跳过**（exit 0，计为 skip），不假装验过。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/document-view-vendor-page-smoke/build.mjs
